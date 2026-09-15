const Otp = require('../models/OtpModel');
const sendEmail = require('../utils/sendEmail');

const sendOtpController = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'ইমেল ঠিকানা প্রয়োজন।' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 3 * 60 * 1000);

    await Otp.findOneAndUpdate(
      { email },
      { otp, otpExpires },
      { upsert: true, new: true }
    );

    const emailSubject = 'আপনার রেজিস্ট্রেশন ভেরিফিকেশন ওটিপি (OTP)';
    const emailBody = `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <h2 style="color: #e11d48;">Blood Donate Society</h2>
        <p>আপনার অ্যাকাউন্ট রেজিস্ট্রেশনের জন্য নিচের ওটিপি কোডটি ব্যবহার করুন:</p>
        <h1 style="background: #f3f4f6; padding: 10px 20px; display: inline-block; letter-spacing: 5px; color: #111;">${otp}</h1>
        <p>কোডটি মাত্র <b>৩ মিনিট</b> পর্যন্ত কার্যকর থাকবে।</p>
      </div>
    `;

    const emailResult = await sendEmail(email, emailSubject, emailBody);

    if (!emailResult.success) {
      return res.status(500).json({ success: false, message: 'ইমেল পাঠানো ব্যর্থ হয়েছে।' });
    }

    res.status(200).json({ success: true, message: 'ওটিপি সফলভাবে পাঠানো হয়েছে।' });

  } catch (error) {
    console.error('Send OTP Error:', error);
    res.status(500).json({ success: false, message: 'সার্ভার ইন্টারনাল এরর।' });
  }
};

const verifyOtpController = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'ইমেল এবং ওটিপি উভয়ই দিতে হবে।' });
    }

    const record = await Otp.findOne({ email });

    if (!record) {
      return res.status(400).json({ success: false, message: 'কোনো ওটিপি রেকর্ড পাওয়া যায়নি।' });
    }

    if (new Date() > new Date(record.otpExpires)) {
      return res.status(400).json({ success: false, message: 'ওটিপির মেয়াদ শেষ হয়ে গেছে।' });
    }

    if (record.otp !== otp) {
      return res.status(400).json({ success: false, message: 'ভুল ওটিপি কোড দিয়েছেন।' });
    }

    await Otp.deleteOne({ email });

    res.status(200).json({ success: true, message: 'ওটিপি সফলভাবে ভেরিফাই হয়েছে!' });

  } catch (error) {
    console.error('Verify OTP Error:', error);
    res.status(500).json({ success: false, message: 'সার্ভার ইন্টারনাল এরর।' });
  }
};

module.exports = {
  sendOtpController,
  verifyOtpController,
};