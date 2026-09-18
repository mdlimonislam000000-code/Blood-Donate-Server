const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: [
    process.env.BETTER_AUTH_URL_CLIENT, 
    "http://localhost:3000",
    "https://mmj-server-kohl.vercel.app"
  ], 
  credentials: true
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Better Auth সেফ হ্যান্ডলিং (ES Module ক্র্যাশ রোধ করার জন্য ডায়নামিক ইমপোর্ট)
(async () => {
  try {
    const { toNodeHandler } = await import("better-auth/node");
    const { auth } = await import("./auth.js");
    app.use("/api/auth", toNodeHandler(auth));
    console.log("Better Auth loaded successfully.");
  } catch (authError) {
    console.log("Better Auth load skipped or error:", authError.message);
  }
})();

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// কানেকশন ক্যাশ করার জন্য গ্লোবাল ভেরিয়েবল (Vercel Serverless এর জন্য অত্যন্ত জরুরি)
let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }
  
  if (!client.topology || !client.topology.isConnected()) {
    await client.connect();
  }
  
  cachedClient = client;
  cachedDb = client.db("MMJ-Blood-bank");
  return { client: cachedClient, db: cachedDb };
}

const getDbCollections = async () => {
  const { db } = await connectToDatabase();
  return {
    nidCollection: db.collection("nidVerifications"),
    usersCollection: db.collection("user"),
    bloodRequestsCollection: db.collection("bloodRequests"),
    donationHistoryCollection: db.collection("donationHistory"),
    notificationsCollection: db.collection("notifications"),
    otpCollection: db.collection("otps"),
  };
};

// এসিনক্রোনাস হ্যান্ডলারের জন্য ট্রাই-ক্যাচ অটোমেশন ফাংশন
const tryCatch = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (error) {
    next(error);
  }
};

// Nodemailer দিয়ে ইমেল পাঠানোর ইউটিলিটি ফাংশন
const sendEmail = async (toEmail, subject, htmlContent) => {
  try {
    if (!toEmail) {
      throw new Error("No recipients defined");
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: `"MMJ Blood Donate" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: subject,
      html: htmlContent,
    };

    const info = await transporter.sendMail(mailOptions);
    return { success: true, response: info.response };
  } catch (error) {
    console.error('Email send error:', error);
    return { success: false, error: error.message };
  }
};

// --- API ROUTES ---

app.post("/api/send-otp", tryCatch(async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, message: 'ইমেল ঠিকানা প্রয়োজন।' });
  }

  const { otpCollection } = await getDbCollections();
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpires = new Date(Date.now() + 3 * 60 * 1000);

  await otpCollection.findOneAndUpdate(
    { email },
    { $set: { otp, otpExpires, createdAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  );

  const emailSubject = 'আপনার রেজিস্ট্রেশন ভেরিফিকেশন ওটিপি (OTP)';
  const emailBody = `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
      <h2 style="color: #e11d48;">MMJ Blood Donate Society</h2>
      <p>আপনার অ্যাকাউন্ট রেজিস্ট্রেশনের জন্য নিচের ওটিপি কোডটি ব্যবহার করুন:</p>
      <h1 style="background: #f3f4f6; padding: 10px 20px; display: inline-block; letter-spacing: 5px; color: #111;">${otp}</h1>
      <p>কোডটি মাত্র <b>৩ মিনিট</b> পর্যন্ত কার্যকর থাকবে।</p>
    </div>
  `;

  const emailResult = await sendEmail(email, emailSubject, emailBody);
  if (!emailResult.success) {
    return res.status(500).json({ success: false, message: 'ইমেল পাঠানো ব্যর্থ হয়েছে।' });
  }

  res.status(200).json({ success: true, message: 'ওটিপি সফলভাবে পাঠানো হয়েছে।' });
}));

app.post("/api/verify-otp", tryCatch(async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ success: false, message: 'ইমেল এবং ওটিপি উভয়ই দিতে হবে।' });
  }

  const { otpCollection } = await getDbCollections();
  const record = await otpCollection.findOne({ email });

  if (!record) {
    return res.status(400).json({ success: false, message: 'কোনো ওটিপি রেকর্ড পাওয়া যায়নি।' });
  }
  if (new Date() > new Date(record.otpExpires)) {
    return res.status(400).json({ success: false, message: 'ওটিপির মেয়াদ শেষ হয়ে গেছে।' });
  }
  if (record.otp !== otp) {
    return res.status(400).json({ success: false, message: 'ভুল ওটিপি কোড দিয়েছেন।' });
  }

  await otpCollection.deleteOne({ email });
  res.status(200).json({ success: true, message: 'ওটিপি সফলভাবে ভেরিফাই হয়েছে!' });
}));

app.get("/api/admin/profile", tryCatch(async (req, res) => {
  const { email } = req.query;
  const { usersCollection } = await getDbCollections();
  
  let adminUser;
  if (email) {
    adminUser = await usersCollection.findOne({ email: email });
  } else {
    adminUser = await usersCollection.findOne({ role: { $regex: /^admin$/i } });
  }

  if (!adminUser) {
    return res.status(404).json({ success: false, message: "Admin not found in database" });
  }

  res.status(200).json({ success: true, admin: adminUser });
}));

app.put("/api/admin/profile", tryCatch(async (req, res) => {
  const updatedData = req.body;
  const { usersCollection } = await getDbCollections();

  let filter = {};
  if (updatedData.email) {
    filter = { email: updatedData.email };
  } else if (updatedData._id && ObjectId.isValid(updatedData._id)) {
    filter = { _id: new ObjectId(updatedData._id) };
  } else {
    return res.status(400).json({ success: false, message: "Email or ID is required for updating profile" });
  }

  const updateDoc = {
    $set: {
      name: updatedData.name,
      phone: updatedData.phone,
      address: updatedData.address,
      image: updatedData.image,
    },
  };

  await usersCollection.updateOne(filter, updateDoc);
  const updatedAdmin = await usersCollection.findOne(filter);
  
  res.status(200).json({ 
    success: true, 
    message: "Profile updated successfully", 
    admin: updatedAdmin || updatedData 
  });
}));

app.post("/api/users", tryCatch(async (req, res) => {
  const userData = req.body;
  const { usersCollection } = await getDbCollections();

  const existingUser = await usersCollection.findOne({ email: userData.email });
  if (existingUser) {
    return res.status(200).json({ success: true, message: "User already exists", data: existingUser });
  }

  const newUser = {
    ...userData,
    role: userData.role || "donor",
    status: userData.status || "active",
    createdAt: new Date(),
  };

  const result = await usersCollection.insertOne(newUser);
  res.status(201).json({ success: true, message: "User created successfully", insertedId: result.insertedId });
}));

app.get("/api/users", tryCatch(async (req, res) => {
  const { usersCollection } = await getDbCollections();
  const result = await usersCollection.find({ role: { $ne: "admin" } }).toArray();
  res.status(200).json({ success: true, data: result });
}));

app.get("/api/users/email/:email", tryCatch(async (req, res) => {
  const email = req.params.email;
  const { usersCollection } = await getDbCollections();
  const user = await usersCollection.findOne({ email: email });

  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  res.status(200).json({ success: true, data: user });
}));

app.patch("/api/users/:id/role", tryCatch(async (req, res) => {
  const id = req.params.id;
  const { role } = req.body;
  const { usersCollection } = await getDbCollections();

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid ID format" });
  }

  const filter = { _id: new ObjectId(id) };
  const updateDoc = { $set: { role: role } };
  const result = await usersCollection.updateOne(filter, updateDoc);

  res.status(200).json({ success: true, message: "User role updated successfully", result });
}));

app.patch("/api/users/:id/status", tryCatch(async (req, res) => {
  const id = req.params.id;
  const { status, suspendUntil } = req.body;
  const { usersCollection } = await getDbCollections();

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid ID format" });
  }

  const filter = { _id: new ObjectId(id) };
  const updateFields = { status: status };
  updateFields.suspendUntil = suspendUntil !== undefined ? suspendUntil : null;

  const updateDoc = { $set: updateFields };
  const result = await usersCollection.updateOne(filter, updateDoc);

  res.status(200).json({ success: true, message: `User status updated to ${status}`, result });
}));

app.delete("/api/users/:id", tryCatch(async (req, res) => {
  const id = req.params.id;
  const { usersCollection, bloodRequestsCollection, donationHistoryCollection, notificationsCollection, nidCollection } = await getDbCollections();

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid ID format" });
  }

  const objectId = new ObjectId(id);
  const user = await usersCollection.findOne({ _id: objectId });
  const userDeleteResult = await usersCollection.deleteOne({ _id: objectId });

  if (userDeleteResult.deletedCount === 0) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  await bloodRequestsCollection.deleteMany({
    $or: [{ userId: id }, { userId: objectId }, ...(user?.email ? [{ authorEmail: user.email }] : [])],
  });
  await donationHistoryCollection.deleteMany({ $or: [{ userId: id }, { userId: objectId }] });
  await notificationsCollection.deleteMany({ $or: [{ userId: id }, { userId: objectId }] });
  await nidCollection.deleteMany({ $or: [{ userId: id }, { userId: objectId }] });

  res.status(200).json({ success: true, message: "User and related records deleted successfully!", userDeleteResult });
}));

app.get("/api/notifications/:userId", tryCatch(async (req, res) => {
  const userId = req.params.userId;
  const { notificationsCollection } = await getDbCollections();
  const result = await notificationsCollection.find({ userId: userId }).sort({ createdAt: -1 }).toArray();
  res.status(200).json({ success: true, data: result });
}));

app.post("/api/notifications", tryCatch(async (req, res) => {
  const { userId, title, message, type } = req.body;
  const { notificationsCollection } = await getDbCollections();

  if (!userId || !title || !message) {
    return res.status(400).json({ success: false, message: "UserId, title and message are required." });
  }

  const newNotification = {
    userId,
    title,
    message,
    type: type || "general",
    isRead: false,
    createdAt: new Date(),
  };

  const result = await notificationsCollection.insertOne(newNotification);
  res.status(201).json({ success: true, message: "Notification created successfully", insertedId: result.insertedId });
}));

app.patch("/api/notifications/read/:id", tryCatch(async (req, res) => {
  const id = req.params.id;
  const { notificationsCollection } = await getDbCollections();

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid ID format" });
  }

  const result = await notificationsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { isRead: true } });
  res.status(200).json({ success: true, message: "Marked as read", result });
}));

app.patch("/api/notifications/read-all/:userId", tryCatch(async (req, res) => {
  const userId = req.params.userId;
  const { notificationsCollection } = await getDbCollections();

  const result = await notificationsCollection.updateMany({ userId: userId, isRead: false }, { $set: { isRead: true } });
  res.status(200).json({ success: true, message: "All notifications marked as read", result });
}));

app.delete("/api/notifications/:id", tryCatch(async (req, res) => {
  const id = req.params.id;
  const { notificationsCollection } = await getDbCollections();

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid ID format" });
  }

  const result = await notificationsCollection.deleteOne({ _id: new ObjectId(id) });
  res.status(200).json({ success: true, message: "Notification deleted successfully", result });
}));

app.get("/api/admin/overview", tryCatch(async (req, res) => {
  const { usersCollection, bloodRequestsCollection } = await getDbCollections();
  const totalUsers = await usersCollection.countDocuments();
  const totalRequests = await bloodRequestsCollection.countDocuments();
  const pendingRequests = await bloodRequestsCollection.countDocuments({ status: { $in: ["Pending", "Not Manage"] } });
  const donationRecords = await bloodRequestsCollection.countDocuments({ status: { $in: ["completed", "Success", "Completed"] } });
  const recentRequests = await bloodRequestsCollection.find().sort({ createdAt: -1 }).limit(5).toArray();

  res.status(200).json({ success: true, totalUsers, totalRequests, pendingRequests, donationRecords, recentRequests });
}));

app.get("/api/admin/statistics", tryCatch(async (req, res) => {
  const { usersCollection, bloodRequestsCollection, donationHistoryCollection } = await getDbCollections();
  const totalUsers = await usersCollection.countDocuments({ role: { $ne: "admin" } });
  const totalDonations = await donationHistoryCollection.countDocuments();
  const pendingRequests = await bloodRequestsCollection.countDocuments({ status: { $in: ["Pending", "Not Manage"] } });
  const totalBloodBagsResult = await bloodRequestsCollection.aggregate([
    { $match: { status: {$in: ["completed", "Success", "Completed"] } } },
    { $group: { _id: null, totalBags: { $sum: "$bags" } } }
  ]).toArray();
  const totalBloodBags = totalBloodBagsResult[0]?.totalBags || 0;

  res.status(200).json({ success: true, data: { totalUsers, totalDonations, pendingRequests, totalBloodBags } });
}));

app.post("/api/verify-nid", tryCatch(async (req, res) => {
  const verificationData = req.body;
  const { nidCollection } = await getDbCollections();

  const newRecord = { ...verificationData, status: "pending", submittedAt: new Date() };
  const result = await nidCollection.insertOne(newRecord);

  res.status(201).json({ success: true, message: "NID verification request submitted successfully!", insertedId: result.insertedId });
}));

app.get("/api/verify-nid/status/:userId", tryCatch(async (req, res) => {
  const userId = req.params.userId;
  const { nidCollection } = await getDbCollections();

  const queryConditions = [{ userId: userId }];
  if (ObjectId.isValid(userId)) {
    queryConditions.push({ userId: new ObjectId(userId) });
  }

  const verification = await nidCollection.findOne({ $or: queryConditions });
  if (!verification) {
    return res.status(200).json({ success: false, message: "Verification record not found" });
  }

  res.status(200).json({ success: true, verification });
}));

const handleGetNidVerifications = async (req, res) => {
  const { status } = req.query;
  const { nidCollection } = await getDbCollections();
  const query = status ? { status } : {};
  const result = await nidCollection.find(query).toArray();
  res.status(200).json({ success: true, data: result });
};

app.get("/api/nid-verifications", tryCatch(handleGetNidVerifications));
app.get("/api/nid-verification", tryCatch(handleGetNidVerifications));

app.patch("/api/nid-verifications/:id", tryCatch(async (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  const { nidCollection, notificationsCollection } = await getDbCollections();

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid ID format" });
  }

  const filter = { _id: new ObjectId(id) };
  const result = await nidCollection.updateOne(filter, { $set: { status: status } });

  const nidRecord = await nidCollection.findOne(filter);
  if (nidRecord && nidRecord.userId) {
    await notificationsCollection.insertOne({
      userId: nidRecord.userId,
      title: "NID Verification Update",
      message: `আপনার NID ভেরিফিকেশন স্ট্যাটাসটি বর্তমানে "${status}" হিসেবে আপডেট করা হয়েছে।`,
      type: "nid_status",
      isRead: false,
      createdAt: new Date(),
    });
  }

  res.status(200).json({ success: true, message: `Status updated to ${status}`, result });
}));

app.delete("/api/nid-verifications/:id", tryCatch(async (req, res) => {
  const id = req.params.id;
  const { nidCollection } = await getDbCollections();

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid ID format" });
  }

  const result = await nidCollection.deleteOne({ _id: new ObjectId(id) });
  res.status(200).json({ success: true, message: "Request deleted successfully", result });
}));

app.post("/api/blood-requests", tryCatch(async (req, res) => {
  const requestData = req.body;
  const { bloodRequestsCollection, notificationsCollection } = await getDbCollections();

  const uniqueDonationCode = Math.floor(100000 + Math.random() * 900000).toString();
  const newBloodRequest = {
    ...requestData,
    bags: requestData.bags ? Number(requestData.bags) : 0,
    patientImage: requestData.patientImage || null,
    status: "Not Manage",
    donationCode: uniqueDonationCode,
    createdAt: new Date(),
  };

  const result = await bloodRequestsCollection.insertOne(newBloodRequest);

  if (requestData.userId) {
    await notificationsCollection.insertOne({
      userId: requestData.userId,
      title: "রক্তের অনুরোধ সফল হয়েছে",
      message: `আপনার ${requestData.bloodGroup} গ্রুপের রক্তের অনুরোধটি সফলভাবে পোস্ট করা হয়েছে।`,
      type: "blood_request",
      isRead: false,
      createdAt: new Date(),
    });
  }

  res.status(201).json({ success: true, message: "Emergency blood request posted successfully!", donationCode: uniqueDonationCode, insertedId: result.insertedId });
}));

app.get("/api/blood-requests", tryCatch(async (req, res) => {
  const { bloodRequestsCollection } = await getDbCollections();
  const result = await bloodRequestsCollection.find().sort({ createdAt: -1 }).toArray();
  res.status(200).json({ success: true, data: result });
}));

app.patch("/api/blood-requests/:id", tryCatch(async (req, res) => {
  const id = req.params.id;
  const updateData = req.body;
  const { bloodRequestsCollection } = await getDbCollections();

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid ID format" });
  }

  const filter = { _id: new ObjectId(id) };
  const updateFields = {};
  for (const key in updateData) {
    if (key === "bags") {
      updateFields[key] = Number(updateData[key]);
    } else if (updateData[key] !== undefined) {
      updateFields[key] = updateData[key];
    }
  }

  const result = await bloodRequestsCollection.updateOne(filter, { $set: updateFields });
  if (result.matchedCount === 0) {
    return res.status(404).json({ success: false, message: "Blood request not found" });
  }

  res.status(200).json({ success: true, message: "Blood request updated successfully!", result });
}));

app.post("/api/blood-requests/verify-and-complete", tryCatch(async (req, res) => {
  const { userId, donationCode, donationDate } = req.body;
  const { bloodRequestsCollection, usersCollection, nidCollection, donationHistoryCollection, notificationsCollection } = await getDbCollections();

  if (!userId || !donationCode) {
    return res.status(400).json({ success: false, message: "User ID and Donation Code are required." });
  }

  const bloodRequest = await bloodRequestsCollection.findOne({ donationCode: donationCode.trim() });
  if (!bloodRequest) {
    return res.status(404).json({ success: false, message: "Invalid donation code! No blood request found with this code." });
  }

  if (bloodRequest.status === "completed" || bloodRequest.status === "Success") {
    return res.status(400).json({ success: false, message: "This donation code has already been used!" });
  }

  const userQuery = ObjectId.isValid(userId) ? { $or: [{ _id: new ObjectId(userId) }, { userId: userId }] } : { userId: userId };
  const user = await usersCollection.findOne(userQuery);

  const currentTotal = user?.totalDonations ? Number(user.totalDonations) : 0;
  const newTotalDonations = currentTotal + 1;
  const finalDate = donationDate || new Date().toISOString().split("T")[0];

  const updatePayload = { lastDonationDate: finalDate, totalDonations: newTotalDonations };

  await usersCollection.updateOne(userQuery, { $set: updatePayload });

  const nidFilter = { $or: [{ userId: userId }, ...(ObjectId.isValid(userId) ? [{ userId: new ObjectId(userId) }] : [])] };
  await nidCollection.updateOne(nidFilter, { $set: updatePayload });

  await bloodRequestsCollection.updateOne(
    { _id: bloodRequest._id },
    { $set: { status: "completed", donorId: userId, donatedAt: new Date() } }
  );

  const historyRecord = {
    userId: userId,
    requestId: new ObjectId(bloodRequest._id),
    donorName: user?.name || bloodRequest.authorName,
    donorEmail: user?.email || "",
    patientName: bloodRequest.patientName,
    hospitalName: bloodRequest.hospitalName,
    hospitalLocation: bloodRequest.hospitalLocation || bloodRequest.location,
    bloodGroup: bloodRequest.bloodGroup,
    bags: bloodRequest.bags,
    donationCode: donationCode,
    donatedDate: finalDate,
    status: "completed",
    createdAt: new Date(),
  };

  await donationHistoryCollection.insertOne(historyRecord);
  await notificationsCollection.insertOne({
    userId: userId,
    title: "ডোনেশন সফলভাবে সম্পন্ন হয়েছে!",
    message: `অভিনন্দন! আপনার ${bloodRequest.bloodGroup} গ্রুপের রক্তদান সফলভাবে ভেরিফাই ও সম্পন্ন হয়েছে।`,
    type: "donation_success",
    isRead: false,
    createdAt: new Date(),
  });

  res.status(200).json({ success: true, message: "Donation verified and completed successfully!", updatedData: updatePayload, history: historyRecord });
}));

app.get("/api/donation-history/all", tryCatch(async (req, res) => {
  const { donationHistoryCollection } = await getDbCollections();
  const result = await donationHistoryCollection.find().sort({ createdAt: -1 }).toArray();
  res.status(200).json({ success: true, data: result });
}));

app.get("/api/donation-history/:userId", tryCatch(async (req, res) => {
  const userId = req.params.userId;
  const { donationHistoryCollection } = await getDbCollections();
  const result = await donationHistoryCollection.find({ userId: userId }).sort({ createdAt: -1 }).toArray();
  res.status(200).json({ success: true, data: result });
}));

app.patch("/api/users/:id", tryCatch(async (req, res) => {
  const id = req.params.id;
  const updatedData = req.body;
  const { usersCollection, nidCollection } = await getDbCollections();

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid user ID format" });
  }

  const filter = { _id: new ObjectId(id) };
  const updateFields = {};
  const nidUpdateFields = {};

  for (const key in updatedData) {
    if (updatedData[key] !== undefined && updatedData[key] !== "" && updatedData[key] !== null) {
      if (typeof updatedData[key] === "object" && !Array.isArray(updatedData[key])) {
        for (const subKey in updatedData[key]) {
          if (updatedData[key][subKey] !== "" && updatedData[key][subKey] !== undefined && updatedData[key][subKey] !== null) {
            updateFields[`${key}.${subKey}`] = updatedData[key][subKey];
            nidUpdateFields[`${key}.${subKey}`] = updatedData[key][subKey];
          }
        }
      } else {
        updateFields[key] = updatedData[key];
        if (key === "name") {
          nidUpdateFields["fullName"] = updatedData[key];
        } else {
          nidUpdateFields[key] = updatedData[key];
        }
      }
    }
  }

  if (Object.keys(updateFields).length === 0) {
    return res.status(400).json({ success: false, message: "No fields provided for update" });
  }

  const userResult = await usersCollection.updateOne(filter, { $set: updateFields });
  const nidFilter = { $or: [{ userId: id }, { userId: new ObjectId(id) }] };
  const nidResult = await nidCollection.updateOne(nidFilter, { $set: nidUpdateFields });

  res.status(200).json({ success: true, message: "Profile updated successfully!", userResult, nidResult });
}));

app.patch("/api/verify-nid/update-donation/:userId", tryCatch(async (req, res) => {
  const userId = req.params.userId;
  const { lastDonationDate, totalDonations } = req.body;
  const { nidCollection } = await getDbCollections();

  const filter = { $or: [{ userId: userId }, ...(ObjectId.isValid(userId) ? [{ userId: new ObjectId(userId) }] : [])] };
  const result = await nidCollection.updateOne(filter, { $set: { lastDonationDate, totalDonations } });

  if (result.matchedCount === 0) {
    return res.status(404).json({ success: false, message: "NID verification record not found for this user" });
  }

  res.status(200).json({ success: true, message: "Donation record updated successfully!", result });
}));

app.patch("/api/users/donor-settings/:id", tryCatch(async (req, res) => {
  const id = req.params.id;
  const { bloodGroup, isAvailableForDonate } = req.body;
  const { usersCollection, nidCollection } = await getDbCollections();

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid user ID format" });
  }

  const filter = { _id: new ObjectId(id) };
  const userResult = await usersCollection.updateOne(filter, { $set: { bloodGroup, isAvailableForDonate } });

  const nidFilter = { $or: [{ userId: id }, { userId: new ObjectId(id) }] };
  const nidResult = await nidCollection.updateOne(nidFilter, { $set: { bloodGroup, isAvailableForDonate } });

  res.status(200).json({ success: true, message: "Donor preferences updated successfully!", userResult, nidResult });
}));

app.get("/", (req, res) => {
  res.status(200).json({ 
    success: true, 
    message: "MMJ Blood Donate server is running successfully!" 
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Global Error Handler:", err.stack);
  res.status(500).json({ success: false, message: err.message });
});

// লোকাল টেস্টের জন্য
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Vercel-এর জন্য এক্সপোর্ট
module.exports = app;