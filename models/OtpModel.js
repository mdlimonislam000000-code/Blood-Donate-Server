const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  otp: { type: String, required: true },
  otpExpires: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now, expires: '3m' }
});

module.exports = mongoose.model('Otp', otpSchema);