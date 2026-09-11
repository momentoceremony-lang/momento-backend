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

// ==========================================
// BREVO EMAIL HELPER FUNCTION
// ==========================================
async function sendEmailViaBrevo(toEmail, subject, htmlContent) {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'api-key': process.env.BREVO_API_KEY,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            sender: { 
                name: 'Momento Support', 
                email: 'bookings@momentoo.in' 
            },
            to: [{ email: toEmail }],
            replyTo: { email: 'momentoceremony@gmail.com' },
            subject: subject,
            htmlContent: htmlContent
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error("Brevo Error:", errorData);
        throw new Error('Failed to send email');
    }
    return await response.json();
}

// Auto-Migrate Database Columns on Startup
// Replace your existing initializeDB function with this:
async function initializeDB() {
    try {
        await pool.query(`
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS specialties JSONB DEFAULT '[]';
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS pricing JSONB DEFAULT '{}';
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS best_shots JSONB DEFAULT '{}';
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS gallery JSONB DEFAULT '[]';
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS bio TEXT;
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS dp_url TEXT;
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS banner_url TEXT;
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS pro_type VARCHAR(50);
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
// 1. SEND OTP (Via Brevo)
// ==========================================
app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    otpStore.set(email, { otp, expiresAt: Date.now() + 5 * 60 * 1000 }); 

    try {
        const subject = 'Your Momento Verification Code';
        const htmlContent = `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                <h2>Welcome to Momento!</h2>
                <p>Your one-time verification code is:</p>
                <h1 style="color: #d4af37; letter-spacing: 2px;">${otp}</h1>
                <p>This code will expire in 5 minutes.</p>
            </div>
        `;
        await sendEmailViaBrevo(email, subject, htmlContent);
        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (error) {
        console.error('Brevo Error:', error);
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
        // FIXED: Restored to inserting into the 'customers' table
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
    const { name, email, phone, password, otp, proType } = req.body;
    const stored = otpStore.get(email);
    
    if (!stored || stored.otp !== otp || Date.now() > stored.expiresAt) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    try {
        const existing = await pool.query('SELECT id FROM photographers WHERE email = $1', [email]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered as Pro.' });

        const hash = await bcrypt.hash(password, await bcrypt.genSalt(10));
        // FIXED: Now correctly saves the 'pro_type' into the database
        const result = await pool.query(
            'INSERT INTO photographers (name, email, phone, password_hash, is_verified, pro_type) VALUES ($1, $2, $3, $4, false, $5) RETURNING id, name, email, phone, pro_type',
            [name, email, phone, hash, proType]
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
// 6. CREATE BOOKING & EMAIL TICKET
// ==========================================
app.post('/api/bookings', async (req, res) => {
    const { customerId, photographerName, category, startDate, endDate, details } = req.body;

    try {
        let proId = null;
        const proRes = await pool.query('SELECT id FROM photographers WHERE name = $1', [photographerName]);
        if (proRes.rows.length > 0) {
            proId = proRes.rows[0].id;
        } else {
            return res.status(400).json({ error: 'Artist not found in the system.' });
        }

        const overlapCheck = await pool.query(
            `SELECT ticket_id FROM bookings 
             WHERE photographer_id = $1 
             AND start_date <= $3 
             AND end_date >= $2`,
            [proId, startDate, endDate]
        );

        if (overlapCheck.rows.length > 0) {
            return res.status(400).json({ error: `${photographerName} is already booked for these dates.` });
        }

        const ticketId = 'TKT-' + Math.random().toString(36).substr(2, 6).toUpperCase();
        const fullDetails = `Requested Photographer: ${photographerName} | ${details}`;

        await pool.query(
            `INSERT INTO bookings (ticket_id, customer_id, photographer_id, category, start_date, end_date, event_details) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [ticketId, customerId, proId, category, startDate, endDate, fullDetails]
        );

        const userRes = await pool.query('SELECT name, email FROM customers WHERE id = $1', [customerId]);
        if (userRes.rows.length > 0) {
            const customerEmail = userRes.rows[0].email;
            const customerName = userRes.rows[0].name;

            const subject = `Booking Request Received: ${ticketId}`;
            const htmlContent = `
                <div style="font-family: Arial, sans-serif; padding: 30px; background-color: #fcf9f6; color: #5a4049; border-radius: 10px; max-width: 500px; margin: auto; border: 1px solid #eaddd7;">
                    <h2 style="color: #5a4049; border-bottom: 2px solid #d19a8a; padding-bottom: 10px;">Booking Request Received</h2>
                    <p>Hello <strong>${customerName}</strong>,</p>
                    <p>Thank you for choosing Momento Photography. We have received your booking request for <strong>${photographerName}</strong>.</p>
                    <div style="background-color: white; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                        <p style="margin: 0; font-size: 14px; opacity: 0.8;">Your Ticket ID</p>
                        <h2 style="color: #d19a8a; margin: 5px 0 0 0; letter-spacing: 2px;">${ticketId}</h2>
                    </div>
                    <p style="font-size: 14px; line-height: 1.6;">Our team is currently checking availability. We will get back to you shortly with a custom quotation and next steps.</p>
                    <p style="font-size: 14px; opacity: 0.8;">Every Moment. Forever.<br>- The Momento Team</p>
                </div>
            `;
            await sendEmailViaBrevo(customerEmail, subject, htmlContent).catch(err => console.error("Email Error:", err));
            
            fetch(process.env.APPS_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'log_booking',
                    ticketId: ticketId,
                    customerName: customerName,
                    photographerName: photographerName,
                    startDate: startDate,
                    endDate: endDate,
                    details: details
                })
            }).catch(err => console.error("Sheets Backup Error:", err));
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
        res.status(500).json({ error: 'DB Error: ' + error.message });
    }
});

// ==========================================
// 8. FETCH ALL PHOTOGRAPHERS
// ==========================================
app.get('/api/photographers', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, bio, dp_url, banner_url, specialties, best_shots, gallery, pricing, pro_type as "proType" FROM photographers WHERE dp_url IS NOT NULL');
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Fetch Pros Error:', error);
        res.status(500).json({ error: 'Failed to fetch photographers' });
    }
});

// ==========================================
// 9. FETCH SINGLE PRO PROFILE
// ==========================================
app.get('/api/pro/profile/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, email, phone, bio, dp_url, banner_url, specialties, best_shots, gallery, pricing, pro_type as "proType" FROM photographers WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Fetch Single Pro Error:', error);
        res.status(500).json({ error: 'Failed to fetch profile data' });
    }
});

// ==========================================
// 10. CHECK PENDING BOOKINGS
// ==========================================
app.get('/api/pro/check-bookings/:id', async (req, res) => {
    try {
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
    
    const stored = otpStore.get(email);
    if (!stored || stored.otp !== otp || Date.now() > stored.expiresAt) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    try {
        await pool.query('DELETE FROM photographers WHERE id = $1', [proId]);
        otpStore.delete(email);

        const subject = "Account Deactivation Confirmed - Momento Photography";
        const htmlContent = `
            <div style="font-family: Arial, sans-serif; padding: 30px; background-color: #fcf9f6; color: #5a4049; border-radius: 10px; max-width: 500px; margin: auto; border: 1px solid #eaddd7;">
                <h2 style="color: #e74c3c; border-bottom: 2px solid #e74c3c; padding-bottom: 10px;">Account Deactivated</h2>
                <p>Hello <strong>${proName}</strong>,</p>
                <p>We have successfully processed your request to permanently delete your Momento Photography Partner Account.</p>
                <p style="font-size: 14px; line-height: 1.6;">Your portfolio and profile are no longer visible to customers. If you have any pending payouts that clear our dispute checks, they will be processed within 30 business days as per the Independent Partner Agreement.</p>
                <p style="font-size: 14px; opacity: 0.8; margin-top: 20px;">Thank you for the time you spent partnering with us. We wish you the best in your photography journey.<br><br>- The Momento Team</p>
            </div>
        `;
        await sendEmailViaBrevo(email, subject, htmlContent).catch(err => console.error("Email Error:", err));

        fetch(process.env.APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                action: 'quit', 
                email: email, 
                name: proName,
                reason: reason 
            })
        }).catch(err => console.error("Sheets Backup Error:", err));

        res.json({ success: true, message: 'Account successfully deactivated.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to process account deletion.' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Momento Server running and exposed on port ${PORT}`);
});
