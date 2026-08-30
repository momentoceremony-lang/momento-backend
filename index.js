const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const otpStore = new Map();

app.get('/', async (req, res) => {
    try {
        const dbRes = await pool.query('SELECT NOW()');
        res.json({ status: 'Success', message: 'Momento Backend API is running smoothly!' });
    } catch (err) {
        res.status(500).json({ status: 'Database Error', error: err.message });
    }
});

// ==========================================
// 1. SEND OTP ROUTE (VIA GOOGLE APPS SCRIPT)
// ==========================================
app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    otpStore.set(email, { otp, expiresAt: Date.now() + 5 * 60 * 1000 }); 

    try {
        // Trigger the Apps Script Web App to send the email
        const scriptRes = await fetch(process.env.APPS_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify({ email: email, otp: otp })
        });
        
        const data = await scriptRes.json();
        
        if (data.success) {
            res.json({ success: true, message: 'OTP sent successfully' });
        } else {
            throw new Error(data.error);
        }
    } catch (error) {
        console.error('Apps Script Trigger Error:', error);
        res.status(500).json({ error: 'Failed to dispatch email via Apps Script.' });
    }
});

// ==========================================
// 2. CUSTOMER REGISTRATION ROUTE
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { name, email, phone, password, otp } = req.body;

    if (!name || !email || !phone || !password || !otp) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    const storedData = otpStore.get(email);
    if (!storedData || storedData.otp !== otp || Date.now() > storedData.expiresAt) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    try {
        const existing = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered. Please Sign In.' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const result = await pool.query(
            'INSERT INTO customers (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, email, phone',
            [name, email, phone, passwordHash]
        );

        otpStore.delete(email); 

        const token = jwt.sign(
            { id: result.rows[0].id, role: 'customer' },
            process.env.JWT_SECRET || 'fallback_secret',
            { expiresIn: '30d' }
        );

        res.json({ success: true, user: result.rows[0], token });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Server error during registration' });
    }
});

// ==========================================
// 3. CUSTOMER LOGIN ROUTE
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const userRes = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
        if (userRes.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        const user = userRes.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign(
            { id: user.id, role: 'customer' },
            process.env.JWT_SECRET || 'fallback_secret',
            { expiresIn: '30d' }
        );

        res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, phone: user.phone }, token });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error during login' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
