const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const otpStore = new Map();

// Auto-Migrate Database Columns on Startup (SAFE VERSION)
async function initializeDB() {
    try {
        // Only add columns if they don't exist. Never drop existing data.
        await pool.query(`
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS specialties JSONB DEFAULT '[]';
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS pricing JSONB DEFAULT '{}';
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS best_shots JSONB DEFAULT '{}';
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS gallery JSONB DEFAULT '[]';
            
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS bio TEXT;
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS dp_url TEXT;
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS banner_url TEXT;
        `);
        console.log("Database schema verified successfully. No data dropped.");
    } catch (err) {
        console.error("DB Initialization Error:", err);
    }
}
initializeDB();

app.get('/', async (req, res) => {
    try {
        await pool.query('SELECT NOW()');
        res.json({ status: 'Success', message: 'Backend is running perfectly!' });
    } catch (err) {
        res.status(500).json({ status: 'Database Error', error: err.message });
    }
});

// ==========================================
// 1. SEND OTP (Via Apps Script)
// ==========================================
app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    otpStore.set(email, { otp, expiresAt: Date.now() + 5 * 60 * 1000 }); 

    try {
        await fetch(process.env.APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'otp', email: email, otp: otp })
        });
        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (error) {
        console.error('Apps Script Error:', error);
        res.status(500).json({ error: 'Failed to dispatch email.' });
    }
});

// ==========================================
// 2. CUSTOMER REGISTRATION
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { name, email, phone, password, otp } = req.body;
    const stored = otpStore.get(email);
    
    if (!stored || stored.otp !== otp || Date.now() > stored.expiresAt) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    try {
        const existing = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered.' });

        const hash = await bcrypt.hash(password, await bcrypt.genSalt(10));
        const result = await pool.query(
            'INSERT INTO customers (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, email, phone',
            [name, email, phone, hash]
        );

        otpStore.delete(email); 
        const token = jwt.sign({ id: result.rows[0].id, role: 'customer' }, process.env.JWT_SECRET || 'momento_fallback', { expiresIn: '30d' });
        res.json({ success: true, user: result.rows[0], token });
    } catch (err) {
        res.status(500).json({ error: 'Server error during registration' });
    }
});

// ==========================================
// 3. CUSTOMER LOGIN 
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const userRes = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
        if (userRes.rows.length === 0) return res.status(400).json({ error: 'Invalid email or password' });

        const isMatch = await bcrypt.compare(password, userRes.rows[0].password_hash);
        if (!isMatch) return res.status(400).json({ error: 'Invalid email or password' });

        const token = jwt.sign({ id: userRes.rows[0].id, role: 'customer' }, process.env.JWT_SECRET || 'momento_fallback', { expiresIn: '30d' });
        res.json({ success: true, user: { id: userRes.rows[0].id, name: userRes.rows[0].name, email: userRes.rows[0].email, phone: userRes.rows[0].phone }, token });
    } catch (err) {
        res.status(500).json({ error: 'Server error during login' });
    }
});

// ==========================================
// 4. PHOTOGRAPHER REGISTRATION
// ==========================================
app.post('/api/auth/pro-register', async (req, res) => {
    const { name, email, phone, password, otp } = req.body;
    const stored = otpStore.get(email);
    
    if (!stored || stored.otp !== otp || Date.now() > stored.expiresAt) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    try {
        const existing = await pool.query('SELECT id FROM photographers WHERE email = $1', [email]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered as Pro.' });

        const hash = await bcrypt.hash(password, await bcrypt.genSalt(10));
        const result = await pool.query(
            'INSERT INTO photographers (name, email, phone, password_hash, is_verified) VALUES ($1, $2, $3, $4, false) RETURNING id, name, email, phone',
            [name, email, phone, hash]
        );

        otpStore.delete(email); 
        const token = jwt.sign({ id: result.rows[0].id, role: 'photographer' }, process.env.JWT_SECRET || 'momento_fallback', { expiresIn: '30d' });
        res.json({ success: true, user: result.rows[0], token });
    } catch (err) {
        res.status(500).json({ error: 'Server error during Pro registration' });
    }
});

// ==========================================
// 5. PHOTOGRAPHER LOGIN
// ==========================================
app.post('/api/auth/pro-login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const userRes = await pool.query('SELECT * FROM photographers WHERE email = $1', [email]);
        if (userRes.rows.length === 0) return res.status(400).json({ error: 'Invalid email or password' });

        const isMatch = await bcrypt.compare(password, userRes.rows[0].password_hash);
        if (!isMatch) return res.status(400).json({ error: 'Invalid email or password' });

        const token = jwt.sign({ id: userRes.rows[0].id, role: 'photographer' }, process.env.JWT_SECRET || 'momento_fallback', { expiresIn: '30d' });
        res.json({ success: true, user: { id: userRes.rows[0].id, name: userRes.rows[0].name, email: userRes.rows[0].email, phone: userRes.rows[0].phone }, token });
    } catch (err) {
        res.status(500).json({ error: 'Server error during Pro login' });
    }
});

// ==========================================
// 6. CREATE BOOKING & EMAIL TICKET (UPDATED)
// ==========================================
app.post('/api/bookings', async (req, res) => {
    const { customerId, photographerName, category, startDate, endDate, details } = req.body;

    try {
        // 1. Get the Photographer's ID
        let proId = null;
        const proRes = await pool.query('SELECT id FROM photographers WHERE name = $1', [photographerName]);
        if (proRes.rows.length > 0) {
            proId = proRes.rows[0].id;
        } else {
            return res.status(400).json({ error: 'Artist not found in the system.' });
        }

        // 2. Overlap Check: Prevent double-booking
        // This queries if there is an existing booking for this pro where the dates intersect
        const overlapCheck = await pool.query(
            `SELECT ticket_id FROM bookings 
             WHERE photographer_id = $1 
             AND start_date <= $3 
             AND end_date >= $2`,
            [proId, startDate, endDate]
        );

        if (overlapCheck.rows.length > 0) {
            return res.status(400).json({ error: `${photographerName} is already booked for these dates. Please choose different dates or select another artist.` });
        }

        // 3. Generate Ticket and Insert
        const ticketId = 'TKT-' + Math.random().toString(36).substr(2, 6).toUpperCase();
        const fullDetails = `Requested Photographer: ${photographerName} | ${details}`;

        await pool.query(
            `INSERT INTO bookings (ticket_id, customer_id, photographer_id, category, start_date, end_date, event_details) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [ticketId, customerId, proId, category, startDate, endDate, fullDetails]
        );

        // 4. Trigger Apps Script Email
        const userRes = await pool.query('SELECT name, email FROM customers WHERE id = $1', [customerId]);
        if (userRes.rows.length > 0) {
            fetch(process.env.APPS_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'booking',
                    email: userRes.rows[0].email,
                    name: userRes.rows[0].name,
                    photographerName: photographerName,
                    ticketId: ticketId
                })
            }).catch(err => console.error("Email Error:", err));
        }

        res.json({ success: true, ticketId: ticketId });
    } catch (err) {
        console.error("Booking Error:", err);
        res.status(500).json({ error: 'Failed to process booking request.' });
    }
});

// ==========================================
// 7. SAVE PHOTOGRAPHER PROFILE
// ==========================================
app.post('/api/pro/profile', async (req, res) => {
    const { proId, bio, dp_url, banner_url, specialties, pricing, best_shots, gallery } = req.body;
    try {
        // We add ::jsonb to force Postgres to accept the stringified arrays/objects safely
        await pool.query(
            `UPDATE photographers 
             SET bio = $1, 
                 dp_url = $2, 
                 banner_url = $3, 
                 specialties = $4::jsonb, 
                 pricing = $5::jsonb, 
                 best_shots = $6::jsonb, 
                 gallery = $7::jsonb
             WHERE id = $8`,
            [bio, dp_url, banner_url, JSON.stringify(specialties), JSON.stringify(pricing), JSON.stringify(best_shots), JSON.stringify(gallery), proId]
        );
        res.json({ success: true, message: 'Profile updated successfully' });
    } catch (error) {
        console.error('Profile Save Error:', error);
        // This sends the EXACT database error to your frontend popup so we know what went wrong
        res.status(500).json({ error: 'DB Error: ' + error.message });
    }
});

// ==========================================
// 8. FETCH ALL PHOTOGRAPHERS (FOR HOMEPAGE)
// ==========================================
app.get('/api/photographers', async (req, res) => {
    try {
        // Fetches all photographers who have uploaded at least a DP
        const result = await pool.query('SELECT id, name, bio, dp_url, banner_url, specialties, best_shots, gallery, pricing FROM photographers WHERE dp_url IS NOT NULL');
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Fetch Pros Error:', error);
        res.status(500).json({ error: 'Failed to fetch photographers' });
    }
});

// ==========================================
// 9. FETCH SINGLE PRO PROFILE (FOR DASHBOARD)
// ==========================================
app.get('/api/pro/profile/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM photographers WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Fetch Single Pro Error:', error);
        res.status(500).json({ error: 'Failed to fetch profile data' });
    }
});

// ==========================================
// 10. CHECK PENDING BOOKINGS (FOR QUITTING)
// ==========================================
app.get('/api/pro/check-bookings/:id', async (req, res) => {
    try {
        // Count bookings that exist for this photographer
        const result = await pool.query('SELECT COUNT(*) FROM bookings WHERE photographer_id = $1', [req.params.id]);
        const pendingCount = parseInt(result.rows[0].count);
        res.json({ success: true, pendingCount });
    } catch (error) {
        res.status(500).json({ error: 'Failed to check active bookings.' });
    }
});

// ==========================================
// 11. PROCESS QUIT & DELETE ACCOUNT
// ==========================================
app.post('/api/pro/quit', async (req, res) => {
    const { proId, email, otp, reason, proName } = req.body;
    
    // 1. Verify OTP
    const stored = otpStore.get(email);
    if (!stored || stored.otp !== otp || Date.now() > stored.expiresAt) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    try {
        // 2. Delete the profile from PostgreSQL
        await pool.query('DELETE FROM photographers WHERE id = $1', [proId]);
        otpStore.delete(email);

        // 3. Trigger Apps Script for CRM notification & Thank You Email
        fetch(process.env.APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                action: 'quit', 
                email: email, 
                name: proName,
                reason: reason 
            })
        }).catch(err => console.error("Apps Script Quit Notification Error:", err));

        res.json({ success: true, message: 'Account successfully deactivated.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to process account deletion.' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Momento Server running and exposed on port ${PORT}`);
});

