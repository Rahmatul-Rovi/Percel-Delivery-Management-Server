const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

// Middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// MongoDB URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.bou0ahg.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect to MongoDB
    await client.connect();

    const db = client.db("parcelDB"); //database name

    const usersCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const userCollection = db.collection("users"); // User Collection
    const ridersCollection = db.collection("riders"); //rider Collection

    // Custom middlewares
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      //verify the token

      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      //verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(401).send({ message: "Unauthorized access" });
      }
    };

    // ------------------------------------------------
    // 🚀 USER RELATED APIS (Eigulo chilo na tai error dito)
    // ------------------------------------------------

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await userCollection.findOne({ email });
      if (userExists) {
        return res
          .status(200)
          .send({ message: "User already exists", insertedId: false });
      }
      const user = req.body;
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // User data save kora (Login er somoy dorkar)
    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await userCollection.findOne(query);

      if (existingUser) {
        return res.send({ message: "User already exists", insertedId: null });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // Shob users der dekha (pore lagbe)
    app.get("/users", async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    // ------------------------------------------------
    // 📦 PARCEL RELATED APIS
    // ------------------------------------------------

    // Shob parcel ene user email diye filter kora
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        let query = {};
        if (email) {
          query = { senderEmail: email };
        }
        const result = await parcelCollection
          .find(query)
          .sort({ _id: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    const { ObjectId } = require("mongodb");
    // 1. Initialize Payment Collection (Add this near your other collections)
    const paymentCollection = db.collection("payments");

    /** * POST: Record successful payment and update parcel status
     * Description: Saves the payment receipt and marks the corresponding parcel as 'paid'.
     */
    app.post("/payments", verifyFBToken, async (req, res) => {
      try {
        const payment = req.body;

        // Save payment details into history
        const insertResult = await paymentCollection.insertOne(payment);

        // Update parcel paymentStatus to "paid" using parcelId
        const query = { _id: new ObjectId(payment.parcelId) };
        const updatedDoc = {
          $set: {
            paymentStatus: "paid",
            transactionId: payment.transactionId,
          },
        };

        const updateResult = await parcelCollection.updateOne(
          query,
          updatedDoc,
        );

        res.status(200).send({ insertResult, updateResult });
      } catch (error) {
        console.error("Payment Record Error:", error);
        res.status(500).send({ message: "Failed to record payment" });
      }
    });

    /** * GET: Load payment history (Dynamic for both User and Admin)
     * Description:
     * - If email is provided: returns history for that specific user.
     * - If no email: returns all history (for Admin).
     * - Sorted by date in descending order (latest first).
     */
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        if (req.decoded.email !== email) {
          return res.status(401).send({ message: "Unauthorized access" });
        }
        let query = {};

        // Filter by email if provided in query params
        if (email) {
          query = { email: email };
        }

        const result = await paymentCollection
          .find(query)
          .sort({ date: -1 }) // Descending order: latest payments at the top
          .toArray();

        res.send(result);
      } catch (error) {
        console.error("Payment History Fetch Error:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // Get a single parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await parcelCollection.findOne(query);

        if (!result) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Invalid ID format or Server Error" });
      }
    });

    // Notun parcel post kora
    app.post("/parcels", async (req, res) => {
      const newParcel = req.body;
      const result = await parcelCollection.insertOne(newParcel);
      res.status(201).send(result);
    });

    // Stripe logic in your server run() function
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amount } = req.body; // amount in taka

        if (!amount) {
          return res.status(400).send({ message: "Amount is required" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // cents
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Parcel delete kora
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });

    //Riders
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    // ১. পেন্ডিং রাইডারদের ডাটা লোড করার এপিআই
    app.get("/riders/pending", async (req, res) => {
      try {
        const query = { status: "pending" };
        const result = await ridersCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // ১. Approve Rider (Status update)
    app.patch("/riders/approve/:id", async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = { $set: { status: "active" } };
      const result = await ridersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // ২. Reject Rider (Delete application)
    app.delete("/riders/reject/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await ridersCollection.deleteOne(query);
      res.send(result);
    });

    // Loading Active Riders Data
    app.get("/riders/active", async (req, res) => {
      const query = { status: "active" };
      const result = await ridersCollection.find(query).toArray();
      res.send(result);
    });

    // Rider Deactivate (Status 'pending')
    app.patch("/riders/deactivate/:id", async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { status: "pending" },
      };
      const result = await ridersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // Ping confirmation
    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB Connected Successfully!");
  } finally {
    // Keep connection open
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Parcel Management Server is Running...");
});

app.listen(port, () => {
  console.log(`Server is running on port: ${port}`);
});
