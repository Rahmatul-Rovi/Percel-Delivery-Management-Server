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

    //const usersCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const userCollection = db.collection("users"); // User Collection
    const ridersCollection = db.collection("riders"); //rider Collection
    const reviewCollection = db.collection("reviews"); //reviews Collection

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

    // -------Verify for admin--------
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    // Admin statistics API
    app.get("/admin-stats", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        // Booking Trends(with date)
        const bookingTrends = await parcelCollection
          .aggregate([
            {
              $group: {
                _id: { $substr: ["$creationDate", 0, 10] }, 
                bookings: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
            { $limit: 7 }, 
          ])
          .toArray();

        // District Stats (Comparison)
        const districtStats = await parcelCollection
          .aggregate([
            {
              $group: {
                _id: "$senderDistrict",
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
          ])
          .toArray();

        res.send({ bookingTrends, districtStats });
      } catch (error) {
        res.status(500).send({ message: "Error fetching stats", error });
      }
    });

    //-----Verify for Rider-------

    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    // ------------------------------------------------
    //     🚨 Admin Related
    // ------------------------------------------------

    // 1. Search User by Email (Case-insensitive check is safer)
    app.get("/users/search-suggestions", async (req, res) => {
      const email = req.query.email;
      if (!email) return res.send([]);

      const query = { email: { $regex: email, $options: "i" } };
      const result = await userCollection
        .find(query)
        .limit(5) 
        .toArray();
      res.send(result);
    });

    /**
     * GET: Fetch User Role by Email
     * Description: Checks the 'users' collection and returns the role.
     * Security: Uses verifyFBToken to ensure the request is from a logged-in user.
     */
    app.get("/users/role/:email", verifyFBToken, async (req, res) => {
      try {
        const email = req.params.email;
        const query = { email: email };
        const user = await userCollection.findOne(query);

        // Check if the user exists
        res.send({
          role: user?.role || "user",
        });
      } catch (error) {
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // User Role Check API (DashBoard Related API for Admin)
    app.get("/users/role/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send({ role: user?.role || "user" });
    });

    // Save User (Social Login or Register User)
    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await userCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "User already exists", insertedId: null });
      }
      const result = await userCollection.insertOne({
        ...user,
        role: user.role || "user", 
        timestamp: new Date(),
      });
      res.send(result);
    });

    // For User Bookibg Stats
    app.get("/user-stats/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const count = await parcelCollection.countDocuments({
        senderEmail: email,
      });
      res.send({ totalBookings: count });
    });

    // For updating Profile Picture
    app.patch("/users/update", verifyFBToken, async (req, res) => {
      const { email, photoURL } = req.body;
      const filter = { email: email };
      const updateDoc = { $set: { image: photoURL } };
      const result = await userCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // Parcel Booking API
    app.post("/parcels", verifyFBToken, async (req, res) => {
      const newParcel = req.body;
      // Stats set from server side
      const result = await parcelCollection.insertOne({
        ...newParcel,
        deliveryStatus: "Processing",
        paymentStatus: "unpaid",
      });
      res.status(201).send(result);
    });

    // 2. Role Update (Security added)
    app.patch(
      "/users/role/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { role } = req.body;

        // Basic validation to ensure role is valid
        if (!["admin", "rider", "user"].includes(role)) {
          return res.status(400).send({ message: "Invalid role type" });
        }

        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: { role: role },
        };

        const result = await userCollection.updateOne(filter, updatedDoc);
        res.send(result);
      },
    );
    // ------------------------------------------------
    // 🚀 USER RELATED APIS 
    // ------------------------------------------------

    // User data save  (Login User)
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

    // Show all users
    app.get("/users", async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    // ------------------------------------------------
    // 📦 PARCEL RELATED APIS
    // ------------------------------------------------

    // All parcels filter with user email
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

    // Rider can show assigned parcel by email with this API
    app.get(
      "/rider-parcels/:email",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.params.email;

          // Tokens email and request email match  (Security)
          if (req.decoded.email !== email) {
            return res.status(403).send({ message: "Forbidden Access" });
          }

          const query = {
            riderEmail: email, 
            // Delivery Status which is not 'Delivered' or 'Cancelled' 
            deliveryStatus: { $in: ["Processing", "in-transit"] },
          };

          const result = await parcelCollection.find(query).toArray();
          res.send(result);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Error fetching rider tasks", error });
        }
      },
    );

    // With this  API Rider  show completed parcel
    // Riders pending cashout balence and completed parcel list 
    app.get(
      "/completed-parcels/:email",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.params.email;
          const query = {
            riderEmail: email,
            deliveryStatus: { $in: ["delivered", "Processing"] }, 
          };

          const result = await parcelCollection.find(query).toArray();

          const parcelsWithEarnings = result.map((parcel) => {
            const cost = Number(parcel.deliveryCost || 0);

            let rate = 0.3;
            if (
              parcel.senderDistrict?.toLowerCase() ===
              parcel.receiverDistrict?.toLowerCase()
            ) {
              rate = 0.8;
            }

            return {
              ...parcel,
              deliveryFee: cost, 
              earnings: cost * rate,
            };
          });

          res.send(parcelsWithEarnings);
        } catch (error) {
          res.status(500).send(error);
        }
      },
    );

    // CashOut request API
    app.post("/cashout", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const { parcelId, riderEmail, amount } = req.body;

        // Check if the parcel is already cashed out
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(parcelId),
        });
        if (parcel.isCashedOut) {
          return res.status(400).send({ message: "Already cashed out!" });
        }

        // Cashout status update 
        await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { isCashedOut: true } },
        );

        // Withdraw record insert
        const withdrawalDoc = {
          parcelId,
          riderEmail,
          amount,
          date: new Date(),
          status: "completed",
        };
        const result = await db
          .collection("withdrawals")
          .insertOne(withdrawalDoc);

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Cashout failed" });
      }
    });

    // Get parcels for assignment (Paid and Processing)
    app.get(
      "/parcels/assignable",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const query = {
          deliveryStatus: "Processing",
          paymentStatus: "paid",
        };
        const result = await parcelCollection.find(query).toArray();
        res.send(result);
      },
    );

    // Rider parcel pickup
    app.patch("/parcel/pickup/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { deliveryStatus: "picked" },
        $push: {
          trackingHistory: {
            status: "Picked Up",
            time: new Date().toLocaleString(),
            message: "Rider has picked up the parcel from sender.",
          },
        },
      };
      const result = await parcelCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // Anyone can track parcel with trackingId
    app.get("/track-parcel/:trackingId", async (req, res) => {
      try {
        const trackingId = req.params.trackingId;
        const query = { trackingId: trackingId };

        const projection = {
          projection: {
            receiverName: 1,
            deliveryStatus: 1,
            trackingHistory: 1,
            senderDistrict: 1,
            receiverDistrict: 1,
          },
        };

        const result = await parcelCollection.findOne(query, projection);

        if (!result) {
          return res.status(404).send({ message: "Invalid Tracking ID" });
        }
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Server error" });
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

    // New Parcel Post
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

    // Parcel delete by ID
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });

    app.patch("/parcel/pickup/:id", async (req, res) => {
      const id = req.params.id;
      const updateDoc = {
        $set: { deliveryStatus: "On The Way" }, // Status Update
        $push: {
          trackingHistory: {
            status: "Picked Up",
            time: new Date().toLocaleString(),
            message:
              "Rider has collected the package and is on the way to delivery.",
          },
        },
      };
      const result = await parcelCollection.updateOne(
        { _id: new ObjectId(id) },
        updateDoc,
      );
      res.send(result);
    });

    app.patch("/parcel/deliver/:id", async (req, res) => {
      const id = req.params.id;
      const updateDoc = {
        $set: { deliveryStatus: "delivered" },
        $push: {
          trackingHistory: {
            status: "Delivered",
            time: new Date().toLocaleString(),
            message: "Parcel successfully handed over to the recipient.",
          },
        },
      };
      const result = await parcelCollection.updateOne(
        { _id: new ObjectId(id) },
        updateDoc,
      );
      res.send(result);
    });

    //Riders
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    //Pending Riders data load API
    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const query = { status: "pending" };
        const result = await ridersCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // ১. Approve Rider (Status update)
    app.patch(
      "/riders/approve/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const filter = { _id: new ObjectId(id) };

          // Rider Application Data
          const application = await ridersCollection.findOne(filter);
          if (!application) {
            return res.status(404).send({ message: "Application not found" });
          }

          const userEmail = application.email;

          // ২. রাইডার অ্যাপ্লিকেশনের স্ট্যাটাস 'active' করা
          const appUpdate = await ridersCollection.updateOne(filter, {
            $set: { status: "active" },
          });

          // ৩. মেইন ইউজার কালেকশনে রোল আপডেট করা
          // আমরা ইমেইল দিয়ে আপডেট করছি এবং নিশ্চিত করছি যেন স্পেলিং এরর না হয়
          const userUpdate = await userCollection.updateOne(
            { email: userEmail },
            { $set: { role: "rider" } },
          );

          console.log(
            `Updated user ${userEmail} to rider. Modified: ${userUpdate.modifiedCount}`,
          );

          res.send({
            success: true,
            message: "Rider approved and role updated",
            appUpdate,
            userUpdate,
          });
        } catch (error) {
          res.status(500).send({ message: error.message });
        }
      },
    );

    // ২. Reject Rider (Delete application)
    app.delete("/riders/reject/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await ridersCollection.deleteOne(query);
      res.send(result);
    });

    // Loading Active Riders Data
    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
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

    // ১. পার্সেলের ডিস্ট্রিক্ট অনুযায়ী রাইডার খোঁজা
    app.get(
      "/users/riders/:district",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const district = req.params.district;
        const query = {
          status: "active",
          district: { $regex: `^${district}$`, $options: "i" },
        };
        const riders = await ridersCollection.find(query).toArray();
        res.send(riders);
      },
    );

    // ২. পার্সেলে রাইডার আপডেট করা
    app.patch(
      "/parcels/assign/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { riderId, riderEmail, riderName, approximateDeliveryDate } =
          req.body;

        // ১. পার্সেলের তথ্য আপডেট (Status: in-transit)
        const parcelFilter = { _id: new ObjectId(id) };
        const parcelUpdate = {
          $set: {
            riderId,
            riderEmail,
            riderName,
            approximateDeliveryDate,
            deliveryStatus: "in-transit", // আপনি যেটা চাইলেন
          },
        };

        // ২. রাইডারের কাজের স্ট্যাটাস আপডেট (Status: in delivery)
        const riderFilter = { _id: new ObjectId(riderId) };
        const riderUpdate = {
          $set: { workStatus: "in delivery" },
        };

        try {
          // দুটি আপডেট একসাথে চালানো হচ্ছে
          const [parcelResult, riderResult] = await Promise.all([
            parcelCollection.updateOne(parcelFilter, parcelUpdate),
            userCollection.updateOne(riderFilter, riderUpdate),
          ]);

          if (parcelResult.modifiedCount > 0) {
            res.send({
              success: true,
              message: "Rider assigned and status updated",
            });
          } else {
            res.status(404).send({ message: "Parcel not found" });
          }
        } catch (error) {
          res.status(500).send({ message: "Update failed", error });
        }
      },
    );

    app.patch("/parcels/status/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { deliveryStatus: status },
      };
      const result = await parcelCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // ইউজারের দেওয়া রিভিউ সেভ করার এপিআই
    app.post("/reviews", async (req, res) => {
      const review = req.body; // { riderEmail, rating, comment, userName, userImage, date }
      const result = await reviewCollection.insertOne(review);

      // বোনাস: রাইডারের প্রোফাইলে টোটাল রিভিউ কাউন্ট আপডেট করতে পারো (ঐচ্ছিক)
      res.send(result);
    });

    // ৩. রাইডার অনুযায়ী রিভিউ পাওয়ার API (রাইডারের প্রোফাইলে দেখানোর জন্য)
    app.get("/reviews/:email", async (req, res) => {
      const email = req.params.email;
      const query = { riderEmail: email };
      const result = await reviewCollection.find(query).toArray();
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
