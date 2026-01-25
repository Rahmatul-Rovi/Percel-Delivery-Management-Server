const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();

// Middleware
app.use(cors());
app.use(express.json());

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

    const db = client.db("parcelDB");
    const parcelCollection = db.collection("parcels");
    const userCollection = db.collection("users"); // User Collection

    // ------------------------------------------------
    // 🚀 USER RELATED APIS (Eigulo chilo na tai error dito)
    // ------------------------------------------------

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
    app.get("/parcels", async (req, res) => {
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

    // Notun parcel post kora
    app.post("/parcels", async (req, res) => {
      const newParcel = req.body;
      const result = await parcelCollection.insertOne(newParcel);
      res.status(201).send(result);
    });

    // Parcel delete kora
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(query);
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