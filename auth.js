const { betterAuth } = require("better-auth");
const { mongodbAdapter } = require("better-auth/adapters/mongodb");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const client = new MongoClient(process.env.MONGO_URI);
const db = client.db("MMJ-Blood-bank");

const auth = betterAuth({
    baseURL: "http://localhost:5000",
    trustedOrigins: ["http://localhost:3000"],

    advanced: {
        useSecureCookies: false, 
        cookiePrefix: "better-auth",
    },

    database: mongodbAdapter(db, {
        disableTransaction: true,
    }),
    
    emailAndPassword: {
        enabled: true,
        autoSignIn: true,
    },
    
    socialProviders: {
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID || process.env.CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || process.env.CLIENT_SECRET,
        },
    },
    
    // Better Auth এর সঠিক নিয়মে অ্যাকাউন্ট লিঙ্কিং এনেবল করা
    account: {
        accountLinking: {
            enabled: true,
            // ইমেইল ম্যাচ করলে গুগল এবং ইমেইল-পাসওয়ার্ড অ্যাকাউন্ট একে অপরের সাথে লিঙ্ক হবে
            trustedProviders: ["google", "email-password"], 
        },
    },
    
    user: {
        additionalFields: {
            role: {
                type: "string",
                required: false,
                defaultValue: "user",
                input: true,
            },
        },
    },
});

module.exports = { auth, db };