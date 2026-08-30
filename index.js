const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Temporary in-memory OTP store (expires in 5 minutes)
const otpStore = new Map();

// Email Transporter setup
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Health check route
app.get('/', async (req, res) => {
    try {
        const dbRes = await pool.query('SELECT NOW()');
        res.json({ 
            status: 'Success', 
            message: 'Momento Backend API is running smoothly!', 
            dbTime: dbRes.rows[0].now 
        });
    } catch (err) {
        res.status(500).json({ status: 'Database Error', error: err.message });
    }
});

// ==========================================
// 1. SEND OTP ROUTE (FREE EMAIL OTP)
// ==========================================
app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    otpStore.set(email, { otp, expiresAt: Date.now() + 5 * 60 * 1000 }); // 5 min expiry

    const mailOptions = {
        from: `"Momento Photography" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Your Verification Code - Momento Photography',
        html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #fcf9f6; color: #5a4049; border-radius: 10px;">
                <h2>Welcome to Momento Photography</h2>
                <p>Your 4-digit verification code is:</p>
                <h1 style="color: #d19a8a; letter-spacing: 5px;">${otp}</h1>
                <p>This code is valid for 5 minutes. Do not share this code with anyone.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: 'OTP sent successfully to your email' });
    } catch (error) {
        console.error('Email error:', error);
        res.status(500).json({ error: 'Failed to send OTP email' });
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

    // Verify OTP
    const storedData = otpStore.get(email);
    if (!storedData || storedData.otp !== otp || Date.now() > storedData.expiresAt) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    try {
        // Check if email already exists
        const existing = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered. Please Sign In.' });
        }

        // Hash Password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Save Customer
        const result = await pool.query(
            'INSERT INTO customers (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, email, phone',
            [name, email, phone, passwordHash]
        );

        otpStore.delete(email); // Clear OTP after success

        // Generate JWT Token
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

        res.json({
            success: true,
            user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
            token
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error during login' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
