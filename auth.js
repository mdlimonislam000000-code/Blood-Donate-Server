const { betterAuth } = require("better-auth");
const { mongodbAdapter } = require("better-auth/adapters/mongodb");
const { MongoClient } = require("mongodb");
require("dotenv").config();

// Vercel সার্ভারলেস এনভায়রনমেন্টের জন্য ক্লায়েন্ট ইনিশিয়ালাইজেশন ও ক্যাশিং
const uri = process.env.MONGO_URI;
let client;
let clientPromise;

if (!uri) {
  throw new Error("Please add your Mongo URI to .env");
}

if (process.env.NODE_ENV === "development") {
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri);
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
} else {
  client = new MongoClient(uri);
  clientPromise = client.connect();
}

// ডাটাবেজ ইন্সট্যান্স তৈরি
const getAuthDb = async () => {
  const connectedClient = await clientPromise;
  return connectedClient.db("MMJ-Blood-bank");
};

// Lazy initialization দিয়ে Better Auth কনফিগারেশন
const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_URL_SERVER || "https://mmj-server-kohl.vercel.app",
    trustedOrigins: [
        process.env.BETTER_AUTH_URL_CLIENT,
        "https://mmj-blood-bank.vercel.app",
        "http://localhost:3000"
    ],

    advanced: {
        useSecureCookies: process.env.NODE_ENV === "production", 
        cookiePrefix: "better-auth",
    },

    database: mongodbAdapter(client.db("MMJ-Blood-bank"), {
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
    
    account: {
        accountLinking: {
            enabled: true,
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

module.exports = { auth };