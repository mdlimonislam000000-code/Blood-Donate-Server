import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

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

export const auth = betterAuth({
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