const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
const nodemailer = require("nodemailer");
require("dotenv").config();

const { hashPassword } = require("better-auth/crypto"); // Better Auth-এর নিজস্ব পাসওয়ার্ড হ্যাশার
const app = express();
const PORT = process.env.PORT || 5000;

const { toNodeHandler } = require("better-auth/node");
const { auth } = require("./auth");

app.use(cors({
  origin: ["http://localhost:3000"], 
  credentials: true
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const uri = process.env.MONGO_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const getDbCollections = () => {
  const database = client.db("MMJ-Blood-bank");
  const nidCollection = database.collection("nidVerifications");
  const usersCollection = database.collection("user");
  const bloodRequestsCollection = database.collection("bloodRequests");
  const donationHistoryCollection = database.collection("donationHistory");
  const notificationsCollection = database.collection("notifications");
  const otpCollection = database.collection("otps"); // ওটিপি এবং পাসওয়ার্ড রিসেটের জন্য কালেকশন
  return {
    nidCollection,
    usersCollection,
    bloodRequestsCollection,
    donationHistoryCollection,
    notificationsCollection,
    otpCollection,
  };
};

// এসিনক্রোনাস হ্যান্ডলারের জন্য ট্রাই-ক্যাচ অটোমেশন ফাংশন
const tryCatch = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
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

async function startServer() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");

    app.use("/api/auth", toNodeHandler(auth));

    // ==========================================
    // ১. ওটিপি সেন্ড করার এপিআই (OTP Send API)
    // ==========================================
    app.post("/api/send-otp", tryCatch(async (req, res) => {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ success: false, message: 'ইমেল ঠিকানা প্রয়োজন।' });
      }

      const { otpCollection } = getDbCollections();

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpires = new Date(Date.now() + 3 * 60 * 1000); // ৩ মিনিট মেয়াদ

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

    // ==========================================
    // ২. ওটিপি ভেরিফাই করার এপিআই (OTP Verify API)
    // ==========================================
    app.post("/api/verify-otp", tryCatch(async (req, res) => {
      const { email, otp } = req.body;

      if (!email || !otp) {
        return res.status(400).json({ success: false, message: 'ইমেল এবং ওটিপি উভয়ই দিতে হবে।' });
      }

      const { otpCollection } = getDbCollections();
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

    // ==========================================
    // ৩. ফোরগট পাসওয়ার্ড এপিআই (Forgot Password API)
    // ==========================================
    app.post("/api/forgot-password", tryCatch(async (req, res) => {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ success: false, message: 'ইমেল ঠিকানা প্রয়োজন।' });
      }

      const database = client.db("MMJ-Blood-bank");
      const userCollection = database.collection("user");
      const { otpCollection } = getDbCollections();
      
      const user = await userCollection.findOne({ email });

      if (!user) {
        return res.status(404).json({ success: false, message: 'এই ইমেল দিয়ে কোনো অ্যাকাউন্ট পাওয়া যায়নি।' });
      }

      const resetToken = Math.floor(100000 + Math.random() * 900000).toString();
      const tokenExpires = new Date(Date.now() + 15 * 60 * 1000); // ১৫ মিনিট মেয়াদ

      await otpCollection.findOneAndUpdate(
        { email },
        { $set: { resetToken, tokenExpires, createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
      );

      const resetLink = `http://localhost:3000/reset-password?email=${encodeURIComponent(email)}&token=${resetToken}`;

      const emailSubject = 'পাসওয়ার্ড রিসেট অনুরোধ (Password Reset)';
      const emailBody = `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #e11d48;">MMJ Blood Donate Society</h2>
          <p>হ্যালো ${user.name || 'ব্যবহারকারী'},</p>
          <p>আপনার অ্যাকাউন্টটি পাসওয়ার্ড রিসেট করার জন্য অনুরোধ করা হয়েছে। নিচের লিংকে ক্লিক করে নতুন পাসওয়ার্ড সেট করুন:</p>
          <a href="${resetLink}" style="background: #e11d48; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">পাসওয়ার্ড রিসেট করুন</a>
          <p style="margin-top: 20px; font-size: 12px; color: #666;">কোড বা লিংকটি ১৫ মিনিট পর্যন্ত কার্যকর থাকবে। আপনি যদি অনুরোধ না করে থাকেন, তবে এই ইমেলটি উপেক্ষা করুন।</p>
        </div>
      `;

      const emailResult = await sendEmail(email, emailSubject, emailBody);

      if (!emailResult.success) {
        return res.status(500).json({ success: false, message: 'পাসওয়ার্ড রিসেট ইমেল পাঠানো ব্যর্থ হয়েছে।' });
      }

      res.status(200).json({ success: true, message: 'পাসওয়ার্ড রিসেট লিংক আপনার ইমেইলে পাঠানো হয়েছে।' });
    }));

    // ==========================================
    // ৪. রিসেট পাসওয়ার্ড কনফার্মেশন এপিআই (Reset Password API)
    // ==========================================
app.post("/api/reset-password", tryCatch(async (req, res) => {
      const { email, token, newPassword } = req.body;

      if (!email || !token || !newPassword) {
        return res.status(400).json({ success: false, message: 'সকল তথ্য প্রদান বাধ্যতামূলক।' });
      }

      const database = client.db("MMJ-Blood-bank");
      const userCollection = database.collection("user");
      const accountCollection = database.collection("account");
      const { otpCollection } = getDbCollections();

      // ১. ওটিপি বা রিসেট টোকেন ভ্যালিডেশন
      const record = await otpCollection.findOne({ email });

      if (!record || record.resetToken !== token) {
        return res.status(400).json({ success: false, message: 'ভুল অথবা মেয়াদোত্তীর্ণ টোকেন।' });
      }

      if (new Date() > new Date(record.tokenExpires)) {
        return res.status(400).json({ success: false, message: 'রিসেট লিংকের মেয়াদ শেষ হয়ে গেছে।' });
      }

      const user = await userCollection.findOne({ email });
      if (!user) {
        return res.status(404).json({ success: false, message: 'ব্যবহারকারী পাওয়া যায়নি।' });
      }

      const userIdObj = new ObjectId(user._id);

      // ২. সরাসরি Better Auth-এর ইন্টারনাল API ব্যবহার করে পাসওয়ার্ড আপডেট করা সবচেয়ে নিরাপদ 
      // অথবা Better Auth-এর ক্রিপ্টো ফাংশন দিয়ে পাসওয়ার্ড আপডেট করার সঠিক স্ট্রাকচার:
      const hashedPassword = await hashPassword(newPassword);

      // ৩. মূল user কালেকশন আপডেট
      await userCollection.updateOne(
        { _id: userIdObj },
        { 
          $set: { 
            updatedAt: new Date() 
          } 
        }
      );

      // ৪. Better Auth-এর account কালেকশনে credential প্রোভাইডার আপডেট বা ইনসার্ট
      const existingAccount = await accountCollection.findOne({ 
        userId: userIdObj, 
        providerId: "credential" 
      });

      if (existingAccount) {
        await accountCollection.updateOne(
          { _id: existingAccount._id },
          { 
            $set: { 
              password: hashedPassword, 
              updatedAt: new Date() 
            } 
          }
        );
      } else {
        await accountCollection.insertOne({
          id: new ObjectId().toString(),
          userId: userIdObj,
          accountId: email,
          providerId: "credential",
          providerAccountId: email,
          password: hashedPassword,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }

      // ৫. ব্যবহৃত রিসেট টোকেন ডিলিট করা
      await otpCollection.deleteOne({ email });

      res.status(200).json({ success: true, message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে!' });
    }));
    // --- অন্যান্য সমস্ত API রাউটসমূহ ---

    app.get("/api/admin/profile", tryCatch(async (req, res) => {
      const { email } = req.query;
      const { usersCollection } = getDbCollections();
      
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
      const { usersCollection } = getDbCollections();

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
      const { usersCollection } = getDbCollections();

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
      const { usersCollection } = getDbCollections();
      const result = await usersCollection.find({ role: { $ne: "admin" } }).toArray();
      res.status(200).json({ success: true, data: result });
    }));

    app.get("/api/users/email/:email", tryCatch(async (req, res) => {
      const email = req.params.email;
      const { usersCollection } = getDbCollections();
      const user = await usersCollection.findOne({ email: email });

      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      res.status(200).json({ success: true, data: user });
    }));

    app.patch("/api/users/:id/role", tryCatch(async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      const { usersCollection } = getDbCollections();

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "Invalid ID format" });
      }

      const filter = { _id: new ObjectId(id) };
      const updateDoc = { $set: { role: role } };
      const result = await usersCollection.updateOne(filter, updateDoc);

      res.status(200).json({
        success: true,
        message: "User role updated successfully",
        result,
      });
    }));

    app.patch("/api/users/:id/status", tryCatch(async (req, res) => {
      const id = req.params.id;
      const { status, suspendUntil } = req.body;
      const { usersCollection } = getDbCollections();

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "Invalid ID format" });
      }

      const filter = { _id: new ObjectId(id) };
      const updateFields = { status: status };

      if (suspendUntil !== undefined) {
        updateFields.suspendUntil = suspendUntil;
      } else {
        updateFields.suspendUntil = null;
      }

      const updateDoc = { $set: updateFields };
      const result = await usersCollection.updateOne(filter, updateDoc);

      res.status(200).json({
        success: true,
        message: `User status updated to ${status}`,
        result,
      });
    }));

    app.delete("/api/users/:id", tryCatch(async (req, res) => {
      const id = req.params.id;
      const {
        usersCollection,
        bloodRequestsCollection,
        donationHistoryCollection,
        notificationsCollection,
        nidCollection,
      } = getDbCollections();

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
        $or: [
          { userId: id },
          { userId: objectId },
          ...(user?.email ? [{ authorEmail: user.email }] : []),
        ],
      });

      await donationHistoryCollection.deleteMany({ $or: [{ userId: id }, { userId: objectId }] });
      await notificationsCollection.deleteMany({ $or: [{ userId: id }, { userId: objectId }] });
      await nidCollection.deleteMany({ $or: [{ userId: id }, { userId: objectId }] });

      res.status(200).json({
        success: true,
        message: "User and all related posts, history & records deleted successfully!",
        userDeleteResult,
      });
    }));

    app.get("/api/notifications/:userId", tryCatch(async (req, res) => {
      const userId = req.params.userId;
      const { notificationsCollection } = getDbCollections();
      const result = await notificationsCollection
        .find({ userId: userId })
        .sort({ createdAt: -1 })
        .toArray();
      res.status(200).json({ success: true, data: result });
    }));

    app.post("/api/notifications", tryCatch(async (req, res) => {
      const { userId, title, message, type } = req.body;
      const { notificationsCollection } = getDbCollections();

      if (!userId || !title || !message) {
        return res.status(400).json({
          success: false,
          message: "UserId, title and message are required.",
        });
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
      res.status(201).json({
        success: true,
        message: "Notification created successfully",
        insertedId: result.insertedId,
      });
    }));

    app.patch("/api/notifications/read/:id", tryCatch(async (req, res) => {
      const id = req.params.id;
      const { notificationsCollection } = getDbCollections();

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "Invalid ID format" });
      }

      const query = { _id: new ObjectId(id) };
      const updateDoc = { $set: { isRead: true } };
      const result = await notificationsCollection.updateOne(query, updateDoc);
      res.status(200).json({ success: true, message: "Marked as read", result });
    }));

    app.patch("/api/notifications/read-all/:userId", tryCatch(async (req, res) => {
      const userId = req.params.userId;
      const { notificationsCollection } = getDbCollections();

      const result = await notificationsCollection.updateMany(
        { userId: userId, isRead: false },
        { $set: { isRead: true } }
      );
      res.status(200).json({
        success: true,
        message: "All notifications marked as read",
        result,
      });
    }));

    app.delete("/api/notifications/:id", tryCatch(async (req, res) => {
      const id = req.params.id;
      const { notificationsCollection } = getDbCollections();

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "Invalid ID format" });
      }

      const query = { _id: new ObjectId(id) };
      const result = await notificationsCollection.deleteOne(query);
      res.status(200).json({
        success: true,
        message: "Notification deleted successfully",
        result,
      });
    }));

    app.get("/api/admin/overview", tryCatch(async (req, res) => {
      const { usersCollection, bloodRequestsCollection } = getDbCollections();
      const totalUsers = await usersCollection.countDocuments();
      const totalRequests = await bloodRequestsCollection.countDocuments();
      const pendingRequests = await bloodRequestsCollection.countDocuments({
        status: { $in: ["Pending", "Not Manage"] },
      });
      const donationRecords = await bloodRequestsCollection.countDocuments({
        status: { $in: ["completed", "Success", "Completed"] },
      });
      const recentRequests = await bloodRequestsCollection
        .find()
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray();

      res.status(200).json({
        success: true,
        totalUsers,
        totalRequests,
        pendingRequests,
        donationRecords,
        recentRequests,
      });
    }));

    app.get("/api/admin/statistics", tryCatch(async (req, res) => {
      const { usersCollection, bloodRequestsCollection, donationHistoryCollection } = getDbCollections();
      const totalUsers = await usersCollection.countDocuments({ role: { $ne: "admin" } });
      const totalDonations = await donationHistoryCollection.countDocuments();
      const pendingRequests = await bloodRequestsCollection.countDocuments({
        status: { $in: ["Pending", "Not Manage"] },
      });
      const totalBloodBagsResult = await bloodRequestsCollection.aggregate([
        { $match: { status: { $in: ["completed", "Success", "Completed"] } } },
        { $group: { _id: null, totalBags: { $sum: "$bags" } } }
      ]).toArray();
      const totalBloodBags = totalBloodBagsResult[0]?.totalBags || 0;

      res.status(200).json({
        success: true,
        data: {
          totalUsers,
          totalDonations,
          pendingRequests,
          totalBloodBags,
        }
      });
    }));

    app.post("/api/verify-nid", tryCatch(async (req, res) => {
      const verificationData = req.body;
      const { nidCollection } = getDbCollections();

      const newRecord = {
        ...verificationData,
        status: "pending",
        submittedAt: new Date(),
      };

      const result = await nidCollection.insertOne(newRecord);

      res.status(201).json({
        success: true,
        message: "NID verification request submitted successfully!",
        insertedId: result.insertedId,
      });
    }));

    app.get("/api/verify-nid/status/:userId", tryCatch(async (req, res) => {
      const userId = req.params.userId;
      const { nidCollection } = getDbCollections();

      const queryConditions = [{ userId: userId }];
      if (ObjectId.isValid(userId)) {
        queryConditions.push({ userId: new ObjectId(userId) });
      }

      const verification = await nidCollection.findOne({ $or: queryConditions });

      if (!verification) {
        return res.status(200).json({
          success: false,
          message: "Verification record not found",
        });
      }

      res.status(200).json({
        success: true,
        verification,
      });
    }));

    const handleGetNidVerifications = async (req, res) => {
      const { status } = req.query;
      const { nidCollection } = getDbCollections();

      const query = status ? { status } : {};
      const result = await nidCollection.find(query).toArray();
      res.status(200).json({ success: true, data: result });
    };

    app.get("/api/nid-verifications", tryCatch(handleGetNidVerifications));
    app.get("/api/nid-verification", tryCatch(handleGetNidVerifications));

    app.patch("/api/nid-verifications/:id", tryCatch(async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;
      const { nidCollection, notificationsCollection } = getDbCollections();

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "Invalid ID format" });
      }

      const filter = { _id: new ObjectId(id) };
      const updatedDoc = { $set: { status: status } };

      const result = await nidCollection.updateOne(filter, updatedDoc);

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

      res.status(200).json({
        success: true,
        message: `Status updated to ${status}`,
        result,
      });
    }));

    app.delete("/api/nid-verifications/:id", tryCatch(async (req, res) => {
      const id = req.params.id;
      const { nidCollection } = getDbCollections();

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "Invalid ID format" });
      }

      const query = { _id: new ObjectId(id) };
      const result = await nidCollection.deleteOne(query);
      res.status(200).json({
        success: true,
        message: "Request deleted successfully",
        result,
      });
    }));

    app.post("/api/blood-requests", tryCatch(async (req, res) => {
      const requestData = req.body;
      const { bloodRequestsCollection, notificationsCollection } = getDbCollections();

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

      res.status(201).json({
        success: true,
        message: "Emergency blood request posted successfully!",
        donationCode: uniqueDonationCode,
        insertedId: result.insertedId,
      });
    }));

    app.get("/api/blood-requests", tryCatch(async (req, res) => {
      const { bloodRequestsCollection } = getDbCollections();
      const result = await bloodRequestsCollection.find().sort({ createdAt: -1 }).toArray();
      res.status(200).json({ success: true, data: result });
    }));

    app.patch("/api/blood-requests/:id", tryCatch(async (req, res) => {
      const id = req.params.id;
      const updateData = req.body;
      const { bloodRequestsCollection } = getDbCollections();

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

      const updatedDoc = { $set: updateFields };
      const result = await bloodRequestsCollection.updateOne(filter, updatedDoc);

      if (result.matchedCount === 0) {
        return res.status(404).json({ success: false, message: "Blood request not found" });
      }

      res.status(200).json({
        success: true,
        message: "Blood request updated successfully!",
        result,
      });
    }));

    app.post("/api/blood-requests/verify-and-complete", tryCatch(async (req, res) => {
      const { userId, donationCode, donationDate } = req.body;
      const {
        bloodRequestsCollection,
        usersCollection,
        nidCollection,
        donationHistoryCollection,
        notificationsCollection,
      } = getDbCollections();

      if (!userId || !donationCode) {
        return res.status(400).json({
          success: false,
          message: "User ID and Donation Code are required.",
        });
      }

      const bloodRequest = await bloodRequestsCollection.findOne({
        donationCode: donationCode.trim(),
      });

      if (!bloodRequest) {
        return res.status(404).json({
          success: false,
          message: "Invalid donation code! No blood request found with this code.",
        });
      }

      if (bloodRequest.status === "completed" || bloodRequest.status === "Success") {
        return res.status(400).json({
          success: false,
          message: "This donation code has already been used!",
        });
      }

      const userQuery = ObjectId.isValid(userId)
        ? { $or: [{ _id: new ObjectId(userId) }, { userId: userId }] }
        : { userId: userId };

      const user = await usersCollection.findOne(userQuery);

      const currentTotal = user?.totalDonations ? Number(user.totalDonations) : 0;
      const newTotalDonations = currentTotal + 1;
      const finalDate = donationDate || new Date().toISOString().split("T")[0];

      const updatePayload = {
        lastDonationDate: finalDate,
        totalDonations: newTotalDonations,
      };

      await usersCollection.updateOne(userQuery, { $set: updatePayload });

      const nidFilter = {
        $or: [
          { userId: userId },
          ...(ObjectId.isValid(userId) ? [{ userId: new ObjectId(userId) }] : []),
        ],
      };
      await nidCollection.updateOne(nidFilter, { $set: updatePayload });

      await bloodRequestsCollection.updateOne(
        { _id: bloodRequest._id },
        {
          $set: {
            status: "completed",
            donorId: userId,
            donatedAt: new Date(),
          },
        }
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

      res.status(200).json({
        success: true,
        message: "Donation verified, history saved, and completed successfully!",
        updatedData: updatePayload,
        history: historyRecord,
      });
    }));

    app.get("/api/donation-history/all", tryCatch(async (req, res) => {
      const { donationHistoryCollection } = getDbCollections();
      const result = await donationHistoryCollection.find().sort({ createdAt: -1 }).toArray();
      res.status(200).json({ success: true, data: result });
    }));

    app.get("/api/donation-history/:userId", tryCatch(async (req, res) => {
      const userId = req.params.userId;
      const { donationHistoryCollection } = getDbCollections();

      const result = await donationHistoryCollection
        .find({ userId: userId })
        .sort({ createdAt: -1 })
        .toArray();

      res.status(200).json({ success: true, data: result });
    }));

    app.patch("/api/users/:id", tryCatch(async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;
      const { usersCollection, nidCollection } = getDbCollections();

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

      const updateDoc = { $set: updateFields };
      const nidUpdateDoc = { $set: nidUpdateFields };

      const userResult = await usersCollection.updateOne(filter, updateDoc);

      const nidFilter = { $or: [{ userId: id }, { userId: new ObjectId(id) }] };
      const nidResult = await nidCollection.updateOne(nidFilter, nidUpdateDoc);

      res.status(200).json({
        success: true,
        message: "Profile updated successfully in both collections!",
        userResult,
        nidResult,
      });
    }));

    app.patch("/api/verify-nid/update-donation/:userId", tryCatch(async (req, res) => {
      const userId = req.params.userId;
      const { lastDonationDate, totalDonations } = req.body;
      const { nidCollection } = getDbCollections();

      const filter = {
        $or: [
          { userId: userId },
          ...(ObjectId.isValid(userId) ? [{ userId: new ObjectId(userId) }] : []),
        ],
      };

      const updateDoc = {
        $set: {
          lastDonationDate: lastDonationDate,
          totalDonations: totalDonations,
        },
      };

      const result = await nidCollection.updateOne(filter, updateDoc);

      if (result.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message: "NID verification record not found for this user",
        });
      }

      res.status(200).json({
        success: true,
        message: "Donation record updated successfully in NID verification!",
        result,
      });
    }));

    app.patch("/api/users/donor-settings/:id", tryCatch(async (req, res) => {
      const id = req.params.id;
      const { bloodGroup, isAvailableForDonate } = req.body;
      const { usersCollection, nidCollection } = getDbCollections();

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "Invalid user ID format" });
      }

      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          bloodGroup: bloodGroup,
          isAvailableForDonate: isAvailableForDonate,
        },
      };

      const userResult = await usersCollection.updateOne(filter, updateDoc);

      const nidFilter = { $or: [{ userId: id }, { userId: new ObjectId(id) }] };
      const nidUpdateDoc = {
        $set: {
          bloodGroup: bloodGroup,
          isAvailableForDonate: isAvailableForDonate,
        },
      };
      const nidResult = await nidCollection.updateOne(nidFilter, nidUpdateDoc);

      res.status(200).json({
        success: true,
        message: "Donor preferences updated successfully in database!",
        userResult,
        nidResult,
      });
    }));

    app.get("/", (req, res) => {
      res.send("MMJ Blood Donate server is running...");
    });

    app.use((err, req, res, next) => {
      console.error("Global Error Handler:", err.stack);
      res.status(500).json({ success: false, message: err.message });
    });

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to connect to MongoDB", error);
  }
}

startServer();