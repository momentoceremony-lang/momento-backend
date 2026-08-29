const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Health check route
app.get('/', async (req, res) => {
    try {
        const dbRes = await pool.query('SELECT NOW()');
        res.json({ 
            status: 'Success', 
            message: 'Momento Backend is running smoothly!', 
            dbTime: dbRes.rows[0].now 
        });
    } catch (err) {
        res.status(500).json({ 
            status: 'Database Error', 
            error: err.message 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
