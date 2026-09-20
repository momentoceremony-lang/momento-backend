const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Razorpay = require('razorpay'); // NEW: Import Razorpay
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// NEW: Initialize Razorpay Instance
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

const otpStore = new Map();

async function sendMomentoEmail(toEmail, toName, subject, htmlContent) {
    try {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': process.env.BREVO_API_KEY,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sender: { name: "Momento CRM", email: "momentoceremony@gmail.com" },
                to: [{ email: toEmail, name: toName }],
                subject: subject,
                htmlContent: htmlContent
            })
        });
        return response.ok;
    } catch (error) {
        console.error("Email dispatch failed:", error);
        return false;
    }
}

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
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS bank_account VARCHAR(100);
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(50);
            
            -- NEW: VERIFICATION TRACKING COLUMNS
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) DEFAULT 'pending';
            ALTER TABLE photographers ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS artist_type VARCHAR(50);
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 8);
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS longitude DECIMAL(11, 8);
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS landmark TEXT;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS quotation_amount DECIMAL(10,2);
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount DECIMAL(10,2) DEFAULT 0;
            
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS advance_amount DECIMAL(10,2) DEFAULT 0;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(10,2) DEFAULT 0;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tracking_id TEXT;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS courier_partner TEXT;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS arrival_photo_url TEXT;

            -- NEW: ADVANCED GPS & EXIT TRACKING COLUMNS
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS arrival_lat DECIMAL(10, 8);
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS arrival_lng DECIMAL(11, 8);
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS artist_left_at TIMESTAMP;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS left_photo_url TEXT;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS left_lat DECIMAL(10, 8);
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS left_lng DECIMAL(11, 8);

            -- NEW: TIMELINE TRACKING COLUMNS
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS quoted_at TIMESTAMP;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS artist_arrived_at TIMESTAMP;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_payment_at TIMESTAMP;
            
            -- NEW: RAZORPAY PREP COLUMNS
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_balance_paid BOOLEAN DEFAULT FALSE;

            -- NEW: FEEDBACK & RATING COLUMNS
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rating INT DEFAULT 0;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS review_text TEXT;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS feedback_submitted BOOLEAN DEFAULT FALSE;

            -- NEW: CRM FEEDBACK MANAGEMENT COLUMNS
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS crm_reviewed_by VARCHAR(50);
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS crm_reviewed_at TIMESTAMP;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS crm_warning_sent BOOLEAN DEFAULT FALSE;
            ALTER TABLE bookings ADD COLUMN IF NOT EXISTS crm_warning_text TEXT;

            -- NEW: Fix old test bookings that have a blank status
            UPDATE bookings SET status = 'pending' WHERE status IS NULL;
            
            -- NEW: CRM USERS TABLE
            CREATE TABLE IF NOT EXISTS crm_users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role VARCHAR(20) NOT NULL,
                must_reset_password BOOLEAN DEFAULT TRUE
            );

            -- NEW: CRM VERIFIED GALLERY SUBMISSIONS
            CREATE TABLE IF NOT EXISTS gallery_submissions (
                id SERIAL PRIMARY KEY,
                photographer_id INT REFERENCES photographers(id) ON DELETE SET NULL, -- Keeps image if artist quits
                image_url TEXT NOT NULL,
                category VARCHAR(50) NOT NULL,
                is_approved BOOLEAN DEFAULT FALSE,
                approved_by VARCHAR(50),
                approved_at TIMESTAMP,
                submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Retroactively update already verified pros to avoid breaking existing accounts
            UPDATE photographers SET account_status = 'approved' WHERE is_verified = true AND (account_status = 'pending' OR account_status IS NULL);

            -- NEW: SYSTEM SETTINGS TABLE
            CREATE TABLE IF NOT EXISTS system_settings (
                id INT PRIMARY KEY,
                maintenance_mode BOOLEAN DEFAULT FALSE
            );
            
            -- Insert the default state if it doesn't exist
            INSERT INTO system_settings (id, maintenance_mode) VALUES (1, FALSE) ON CONFLICT (id) DO NOTHING;
            
        `);

        // Inject Default CRM Accounts if they don't exist
        const devCheck = await pool.query("SELECT * FROM crm_users WHERE username = 'Developer'");
        if (devCheck.rows.length === 0) {
            const devHash = await bcrypt.hash('DC@789', 10);
            await pool.query("INSERT INTO crm_users (username, password_hash, role, must_reset_password) VALUES ($1, $2, $3, true)", ['Developer', devHash, 'developer']);
        }

        const adminCheck = await pool.query("SELECT * FROM crm_users WHERE username = 'Admin'");
        if (adminCheck.rows.length === 0) {
            const adminHash = await bcrypt.hash('Momento', 10);
            await pool.query("INSERT INTO crm_users (username, password_hash, role, must_reset_password) VALUES ($1, $2, $3, true)", ['Admin', adminHash, 'admin']);
        }

        console.log("Database schema & CRM defaults verified successfully.");
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
    const { customerId, photographerName, artistType, category, startDate, endDate, latitude, longitude, landmark, details } = req.body;

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
        // Pack all details into the legacy event_details column just in case, while also saving properly to the new columns
        const fullDetails = `Requested: ${photographerName} (${artistType}) | Landmark: ${landmark} | ${details}`;

        // Insert including the new Map and Artist Type columns, PLUS explicit 'pending' status
        await pool.query(
            `INSERT INTO bookings (ticket_id, customer_id, photographer_id, artist_type, category, start_date, end_date, latitude, longitude, landmark, event_details, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')`,
            [ticketId, customerId, proId, artistType, category, startDate, endDate, latitude, longitude, landmark, fullDetails]
        );

        const userRes = await pool.query('SELECT name, email FROM customers WHERE id = $1', [customerId]);
        if (userRes.rows.length > 0) {
            const customerEmail = userRes.rows[0].email;
            const customerName = userRes.rows[0].name;

            const subject = `Booking Request Received: ${ticketId}`;
            const mapsLink = latitude && longitude ? `https://www.google.com/maps?q=${latitude},${longitude}` : '';
            
            // Sweet looking email with the new details
            const htmlContent = `
                <div style="font-family: Arial, sans-serif; padding: 30px; background-color: #fcf9f6; color: #5a4049; border-radius: 10px; max-width: 500px; margin: auto; border: 1px solid #eaddd7;">
                    <h2 style="color: #5a4049; border-bottom: 2px solid #d19a8a; padding-bottom: 10px;">Booking Request Received</h2>
                    <p>Hello <strong>${customerName}</strong>,</p>
                    <p>Thank you for choosing Momento. We have received your booking request for <strong>${photographerName}</strong> (${artistType} - ${category}).</p>
                    
                    <div style="background-color: white; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                        <p style="margin: 0; font-size: 14px; opacity: 0.8;">Your Ticket ID</p>
                        <h2 style="color: #d19a8a; margin: 5px 0 0 0; letter-spacing: 2px;">${ticketId}</h2>
                    </div>
                    
                    <div style="background-color: white; padding: 15px; border-radius: 8px; margin: 20px 0; font-size: 14px; line-height: 1.6;">
                        <strong>Dates:</strong> ${startDate} to ${endDate}<br>
                        <strong>Location:</strong> <a href="${mapsLink}" target="_blank" style="color: #d19a8a; text-decoration: underline;">View Map Pin</a><br>
                        <strong>Landmark:</strong> ${landmark || 'N/A'}<br>
                        <strong>Requirements:</strong> ${details || 'N/A'}
                    </div>

                    <p style="font-size: 14px; line-height: 1.6;">Our team is reviewing the artist's availability. We will get back to you shortly with a custom quotation and next steps.</p>
                    <p style="font-size: 14px; opacity: 0.8;">Every Moment. Forever.<br>- The Momento Team</p>
                </div>
            `;
            await sendEmailViaBrevo(customerEmail, subject, htmlContent).catch(err => console.error("Email Error:", err));
            
            // Push everything to the Google CRM
            fetch(process.env.APPS_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'log_booking',
                    ticketId: ticketId,
                    customerName: customerName,
                    photographerName: photographerName,
                    artistType: artistType,
                    category: category,
                    startDate: startDate,
                    endDate: endDate,
                    latitude: latitude,
                    longitude: longitude,
                    landmark: landmark,
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
    const { proId, bio, dp_url, banner_url, specialties, pricing, best_shots, gallery, bank_account, ifsc_code } = req.body;
    try {
        await pool.query(
            `UPDATE photographers 
             SET bio = $1, 
                 dp_url = $2, 
                 banner_url = $3, 
                 specialties = $4::jsonb, 
                 pricing = $5::jsonb, 
                 best_shots = $6::jsonb, 
                 gallery = $7::jsonb,
                 bank_account = $8,
                 ifsc_code = $9
             WHERE id = $10`,
            [bio, dp_url, banner_url, JSON.stringify(specialties), JSON.stringify(pricing), JSON.stringify(best_shots), JSON.stringify(gallery), bank_account, ifsc_code, proId]
        );
        res.json({ success: true, message: 'Profile updated successfully' });
    } catch (error) {
        console.error('Profile Save Error:', error);
        res.status(500).json({ error: 'DB Error: ' + error.message });
    }
});

// ==========================================
// 8. FETCH ALL PHOTOGRAPHERS (PUBLIC)
// ==========================================
app.get('/api/photographers', async (req, res) => {
    try {
        const query = `
            SELECT p.id, p.name, p.bio, p.dp_url, p.banner_url, p.specialties, p.best_shots, p.gallery, p.pricing, p.pro_type as "proType",
                   COALESCE(AVG(b.rating) FILTER (WHERE b.rating > 0), 0) as avg_rating,
                   COUNT(b.rating) FILTER (WHERE b.rating > 0) as review_count
            FROM photographers p
            LEFT JOIN bookings b ON p.id = b.photographer_id
            WHERE p.dp_url IS NOT NULL AND p.is_verified = true
            GROUP BY p.id
        `;
        const result = await pool.query(query);
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
        const query = `
            SELECT p.id, p.name, p.email, p.phone, p.bio, p.dp_url, p.banner_url, p.specialties, p.best_shots, p.gallery, p.pricing, p.pro_type as "proType", p.is_verified, p.account_status, p.bank_account, p.ifsc_code,
                   COALESCE(AVG(b.rating) FILTER (WHERE b.rating > 0), 0) as avg_rating,
                   COUNT(b.rating) FILTER (WHERE b.rating > 0) as review_count
            FROM photographers p
            LEFT JOIN bookings b ON p.id = b.photographer_id
            WHERE p.id = $1
            GROUP BY p.id
        `;
        const result = await pool.query(query, [req.params.id]);
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

// ==========================================
// CRM: LOGIN
// ==========================================
app.post('/api/crm/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const userRes = await pool.query('SELECT * FROM crm_users WHERE username = $1', [username]);
        if (userRes.rows.length === 0) return res.status(400).json({ error: 'Invalid credentials' });

        const isMatch = await bcrypt.compare(password, userRes.rows[0].password_hash);
        if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

        const user = userRes.rows[0];
        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'momento_fallback', { expiresIn: '12h' });
        
        res.json({ 
            success: true, 
            token, 
            user: { username: user.username, role: user.role, must_reset: user.must_reset_password } 
        });
    } catch (err) {
        res.status(500).json({ error: 'CRM Login Error' });
    }
});

// ==========================================
// CRM: FORCED PASSWORD RESET
// ==========================================
app.post('/api/crm/reset-password', async (req, res) => {
    const { username, oldPassword, newPassword } = req.body;
    try {
        const userRes = await pool.query('SELECT * FROM crm_users WHERE username = $1', [username]);
        if (userRes.rows.length === 0) return res.status(400).json({ error: 'User not found' });

        const isMatch = await bcrypt.compare(oldPassword, userRes.rows[0].password_hash);
        if (!isMatch) return res.status(400).json({ error: 'Authentication failed' });

        const newHash = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE crm_users SET password_hash = $1, must_reset_password = false WHERE username = $2', [newHash, username]);
        
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// ==========================================
// CRM: ARTIST VERIFICATION ENGINE (V2)
// ==========================================
app.get('/api/crm/pending-artists', async (req, res) => {
    try {
        const pending = await pool.query("SELECT * FROM photographers WHERE account_status = 'pending' OR account_status IS NULL ORDER BY id DESC");
        const rejected = await pool.query("SELECT * FROM photographers WHERE account_status = 'rejected' ORDER BY id DESC");
        // ADDED: The missing query to fetch live artists!
        const approved = await pool.query("SELECT * FROM photographers WHERE account_status = 'approved' ORDER BY id DESC");
        
        res.json({ success: true, pending: pending.rows, rejected: rejected.rows, approved: approved.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch verification lists' });
    }
});

app.post('/api/crm/approve-artist', async (req, res) => {
    const { id } = req.body;
    try {
        const query = await pool.query("UPDATE photographers SET is_verified = true, account_status = 'approved' WHERE id = $1 RETURNING name, email", [id]);
        
        // Dispatch Welcome Email
        if (query.rows.length > 0) {
            const artist = query.rows[0];
            const html = `
                <div style="font-family: Arial, sans-serif; color: #3C3633;">
                    <h2 style="color: #d19a8a;">Congratulations, ${artist.name}! 🎉</h2>
                    <p>Your Momento Professional profile has been successfully verified.</p>
                    <p>You are now an official part of the Momento family. Customers can view your portfolio, and you are eligible to receive booking requests directly through your dashboard.</p>
                    <br><p>Best Regards,<br><strong>The Momento Team</strong></p>
                </div>`;
            await sendMomentoEmail(artist.email, artist.name, "Welcome to Momento! Your Profile is Live", html);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to approve artist' });
    }
});

app.post('/api/crm/reject-artist', async (req, res) => {
    const { id, reason } = req.body;
    try {
        const query = await pool.query("UPDATE photographers SET is_verified = false, account_status = 'rejected', rejection_reason = $2 WHERE id = $1 RETURNING name, email", [id, reason]);
        
        // Dispatch Action Required Email
        if (query.rows.length > 0) {
            const artist = query.rows[0];
            const html = `
                <div style="font-family: Arial, sans-serif; color: #3C3633;">
                    <h2>Action Required, ${artist.name}</h2>
                    <p>We are currently reviewing your Momento Professional application. To officially list your profile, we need you to update a few details.</p>
                    <div style="background: #f9f9f9; padding: 15px; border-left: 4px solid #e74c3c; margin: 20px 0;">
                        <strong>Feedback from our team:</strong><br>
                        ${reason}
                    </div>
                    <p>Please log in to your Pro Dashboard, make the necessary updates, and we will automatically re-evaluate your profile.</p>
                    <br><p>Best Regards,<br><strong>The Momento Team</strong></p>
                </div>`;
            await sendMomentoEmail(artist.email, artist.name, "Action Required: Update Your Momento Profile", html);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reject artist' });
    }
});

// ==========================================
// CRM: BOOKING PIPELINE & QUOTATIONS
// ==========================================
app.get('/api/crm/bookings', async (req, res) => {
    try {
        const query = `
            SELECT b.*, 
                   COALESCE(c.name, 'Deleted Customer') as customer_name, 
                   c.email as customer_email, c.phone as customer_phone,
                   COALESCE(p.name, 'Deleted Artist') as pro_name, 
                   p.pro_type,
                   p.pricing -- NEW: Fetching the pricing JSON
            FROM bookings b
            LEFT JOIN customers c ON b.customer_id = c.id
            LEFT JOIN photographers p ON b.photographer_id = p.id
            ORDER BY b.id DESC
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error("Fetch Bookings Error:", err);
        res.status(500).json({ error: 'Failed to fetch bookings' });
    }
});

app.post('/api/crm/send-quotation', async (req, res) => {
    const { ticketId, amount, discount, advanceAmount, customerEmail, customerName, proName } = req.body;
    try {
        let paymentLinkUrl = "";
        let razorpayLinkId = null;

        // 1. Generate Razorpay Payment Link if an advance is required
        if (advanceAmount > 0) {
            const advancePaise = Math.round(advanceAmount * 100); // Razorpay requires amounts in paise (multiply by 100)
            
            const paymentLinkRequest = {
                amount: advancePaise,
                currency: "INR",
                accept_partial: false,
                description: `Advance Payment to secure Momento Booking: ${ticketId}`,
                customer: {
                    name: customerName,
                    email: customerEmail
                },
                notify: {
                    sms: false,
                    email: false // We handle the email beautifully via Brevo instead
                },
                reminder_enable: false,
                notes: {
                    ticket_id: ticketId,
                    payment_type: 'advance'
                }
            };
            
            const paymentLink = await razorpay.paymentLink.create(paymentLinkRequest);
            paymentLinkUrl = paymentLink.short_url;
            razorpayLinkId = paymentLink.id; // Store this so we can verify payments later
        }

        // 2. If the Admin changed the Artist Name, look up the new Artist's ID
        const proRes = await pool.query('SELECT id FROM photographers WHERE name = $1', [proName]);
        let targetProId = null;
        if (proRes.rows.length > 0) targetProId = proRes.rows[0].id;

        // 3. Update the booking and save the Razorpay Order ID
        if (targetProId) {
            await pool.query(
                "UPDATE bookings SET status = 'quotation_sent', quotation_amount = $1, discount = $2, advance_amount = $3, photographer_id = $4, quoted_at = CURRENT_TIMESTAMP, razorpay_order_id = $5 WHERE ticket_id = $6",
                [amount, discount, advanceAmount, targetProId, razorpayLinkId, ticketId]
            );
        } else {
            await pool.query(
                "UPDATE bookings SET status = 'quotation_sent', quotation_amount = $1, discount = $2, advance_amount = $3, quoted_at = CURRENT_TIMESTAMP, razorpay_order_id = $4 WHERE ticket_id = $5",
                [amount, discount, advanceAmount, razorpayLinkId, ticketId]
            );
        }

        // 4. Send the Milestone Email via Brevo with the embedded Payment Button
        const paymentButtonHTML = paymentLinkUrl 
            ? `<div style="text-align: center; margin-top: 25px;">
                 <a href="${paymentLinkUrl}" style="background-color: #d19a8a; color: #0f0f10; padding: 14px 28px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 15px rgba(209, 154, 138, 0.4);">Pay Advance Securely</a>
               </div>`
            : '';

        const html = `
            <div style="font-family: Arial, sans-serif; color: #3C3633; max-width: 500px; margin: auto; border: 1px solid #eaddd7; border-radius: 10px; padding: 30px; background-color: #fcf9f6;">
                <h2 style="color: #d19a8a; border-bottom: 2px solid #d19a8a; padding-bottom: 10px;">Your Custom Quotation</h2>
                <p>Hello <strong>${customerName}</strong>,</p>
                <p>Great news! We have reviewed your booking request and confirmed availability for <strong>${proName}</strong> (Ticket: ${ticketId}).</p>
                
                <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                    <p style="margin: 0; font-size: 14px; opacity: 0.8;">Total Amount Due</p>
                    <h1 style="color: #5a4049; margin: 5px 0;">₹${amount}</h1>
                    <p style="color: #e74c3c; font-weight: bold; margin-top: 15px; border-top: 1px dashed #ddd; padding-top: 10px;">Advance Required to Confirm Dates: ₹${advanceAmount}</p>
                    ${discount > 0 ? `<p style="color: #27ae60; font-size: 13px; font-weight: bold; margin-top: 5px;">Includes a ₹${discount} discount!</p>` : ''}
                </div>
                
                <p>To lock in your dates, please process the advance payment securely using the link below.</p>
                
                ${paymentButtonHTML}

                <p style="font-size: 14px; opacity: 0.8; margin-top: 30px;">Every Moment. Forever.<br>- The Momento Team</p>
            </div>`;
            
        await sendMomentoEmail(customerEmail, customerName, `Quotation Ready for Ticket: ${ticketId}`, html);
        res.json({ success: true });
    } catch (err) {
        console.error("Send Quotation Error:", err);
        res.status(500).json({ error: 'Failed to send quotation and generate payment link' });
    }
});

// Route to manually mark a payment as received
app.post('/api/crm/confirm-booking', async (req, res) => {
    const { ticketId } = req.body;
    try {
        await pool.query("UPDATE bookings SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE ticket_id = $1", [ticketId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to confirm booking' });
    }
});

// Route to finalize the job and send physical deliverables
app.post('/api/crm/complete-booking', async (req, res) => {
    const { ticketId, trackingId, courier, customerEmail, customerName } = req.body;
    try {
        await pool.query(
            "UPDATE bookings SET status = 'completed', tracking_id = $1, courier_partner = $2, completed_at = CURRENT_TIMESTAMP WHERE ticket_id = $3",
            [trackingId, courier, ticketId]
        );
        
        const html = `
            <div style="font-family: Arial, sans-serif; color: #3C3633; max-width: 500px; margin: auto; border: 1px solid #eaddd7; border-radius: 10px; padding: 30px; background-color: #fcf9f6;">
                <h2 style="color: #8e44ad; border-bottom: 2px solid #8e44ad; padding-bottom: 10px;">Your Memories Are on the Way!</h2>
                <p>Hello <strong>${customerName}</strong>,</p>
                <p>Your deliverables (Pen Drive / Album) for Ticket <strong>${ticketId}</strong> have been finalized and dispatched.</p>
                <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                    <p><strong>Courier Partner:</strong> ${courier}</p>
                    <p><strong>Tracking ID:</strong> <span style="color: #8e44ad; font-weight: bold; letter-spacing: 1px;">${trackingId}</span></p>
                </div>
                <p>Thank you for choosing Momento to capture your special day!</p>
            </div>`;
            
        await sendMomentoEmail(customerEmail, customerName, `Your Deliverables Dispatched! (${ticketId})`, html);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to complete booking' });
    }
});

// ==========================================
// SYSTEM SETTINGS & MAINTENANCE MODE
// ==========================================
// Public route for the main website to check status
app.get('/api/system/status', async (req, res) => {
    try {
        const result = await pool.query('SELECT maintenance_mode FROM system_settings WHERE id = 1');
        res.json({ maintenance: result.rows[0].maintenance_mode });
    } catch (err) {
        // If DB fails, assume live to prevent accidental lockouts
        res.json({ maintenance: false }); 
    }
});

// Protected route for the CRM to flip the switch
app.post('/api/crm/system/maintenance', async (req, res) => {
    const { active } = req.body;
    try {
        await pool.query('UPDATE system_settings SET maintenance_mode = $1 WHERE id = 1', [active]);
        res.json({ success: true, maintenance: active });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update system settings' });
    }
});


// ==========================================
// 12. CUSTOMER DASHBOARD (FETCH OWN BOOKINGS)
// ==========================================
app.get('/api/customer/bookings/:customerId', async (req, res) => {
    try {
        const query = `
            SELECT b.ticket_id, b.status, b.artist_type, b.category, 
                   b.start_date, b.end_date, b.quotation_amount, b.advance_amount,
                   b.created_at, b.quoted_at, b.confirmed_at, b.artist_arrived_at, 
                   b.artist_left_at, b.final_payment_at, b.completed_at,
                   b.arrival_lat, b.arrival_lng, b.left_photo_url, b.left_lat, b.left_lng,
                   b.rating, b.review_text, b.feedback_submitted, -- NEW: Added feedback columns
                   b.courier_partner, b.tracking_id,
                   COALESCE(p.name, 'Assigned Artist') as pro_name,
                   p.dp_url
            FROM bookings b
            LEFT JOIN photographers p ON b.photographer_id = p.id
            WHERE b.customer_id = $1
            ORDER BY b.id DESC
        `;
        const result = await pool.query(query, [req.params.customerId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Customer Dashboard Error:", error);
        res.status(500).json({ error: 'Failed to fetch your bookings.' });
    }
});

// ==========================================
// 13. PRO DASHBOARD (FETCH OWN CONFIRMED BOOKINGS)
// ==========================================
app.get('/api/pro/bookings/:proId', async (req, res) => {
    try {
        const query = `
            SELECT b.ticket_id, b.status, b.category, 
                   b.start_date, b.end_date, b.landmark, b.event_details,
                   b.latitude, b.longitude, 
                   b.arrival_lat, b.arrival_lng, b.artist_left_at, b.left_photo_url, b.left_lat, b.left_lng,
                   COALESCE(c.name, 'Customer') as customer_name,
                   c.phone as customer_phone
            FROM bookings b
            LEFT JOIN customers c ON b.customer_id = c.id
            WHERE b.photographer_id = $1 
            AND b.status IN ('confirmed', 'artist_arrived', 'artist_left', 'final_paid', 'completed')
            ORDER BY b.start_date ASC
        `;
        const result = await pool.query(query, [req.params.proId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Pro Dashboard Bookings Error:", error);
        res.status(500).json({ error: 'Failed to fetch bookings.' });
    }
});

// ==========================================
// 14. RAZORPAY WEBHOOK (AUTOMATIC PAYMENT CONFIRMATION)
// ==========================================
app.post('/api/webhooks/razorpay', async (req, res) => {
    // 1. Verify the request actually came from Razorpay
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== req.headers['x-razorpay-signature']) {
        return res.status(400).json({ error: 'Invalid signature' });
    }

    try {
        const event = req.body.event;

        // 2. Listen specifically for successful payment links
        if (event === 'payment_link.paid') {
            const paymentLink = req.body.payload.payment_link.entity;
            const ticketId = paymentLink.notes.ticket_id; 
            const paymentType = paymentLink.notes.payment_type || 'advance';

            if (paymentType === 'final') {
                await pool.query(
                    "UPDATE bookings SET status = 'final_paid', final_payment_at = CURRENT_TIMESTAMP WHERE ticket_id = $1",
                    [ticketId]
                );
                console.log(`✅ Webhook Success: Ticket ${ticketId} FINAL balance paid.`);
            } else {
                await pool.query(
                    "UPDATE bookings SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE ticket_id = $1",
                    [ticketId]
                );
                console.log(`✅ Webhook Success: Ticket ${ticketId} advance paid.`);
            }
        } // <-- This is the curly brace that was missing!

        res.status(200).json({ status: 'ok' });
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// ==========================================
// 15. FETCH UNAVAILABLE DATES FOR CALENDAR
// ==========================================
app.get('/api/pro/:name/blocked-dates', async (req, res) => {
    try {
        const proRes = await pool.query('SELECT id FROM photographers WHERE name = $1', [req.params.name]);
        if (proRes.rows.length === 0) return res.status(404).json({ error: 'Artist not found' });
        
        const proId = proRes.rows[0].id;
        
        // Fetch only dates where the booking is confirmed or completed
        const query = `
            SELECT start_date, end_date 
            FROM bookings 
            WHERE photographer_id = $1 
            AND status IN ('confirmed', 'completed')
        `;
        const result = await pool.query(query, [proId]);
        
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Fetch Blocked Dates Error:", error);
        res.status(500).json({ error: 'Failed to fetch blocked dates.' });
    }
});

// ==========================================
// 16. PUBLIC TICKET TRACKING
// ==========================================
app.get('/api/track/:ticketId', async (req, res) => {
    try {
        const query = `
            SELECT b.ticket_id, b.status, b.artist_type, b.category, 
                   b.created_at, b.quoted_at, b.confirmed_at, b.artist_arrived_at, 
                   b.artist_left_at, b.final_payment_at, b.completed_at,
                   b.arrival_lat, b.arrival_lng, b.left_photo_url, b.left_lat, b.left_lng,
                   b.courier_partner, b.tracking_id,
                   COALESCE(p.name, 'Assigned Artist') as pro_name
            FROM bookings b
            LEFT JOIN photographers p ON b.photographer_id = p.id
            WHERE b.ticket_id = $1
        `;
        const result = await pool.query(query, [req.params.ticketId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket not found. Please check your Ticket ID.' });
        }
        
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Tracking Error:", error);
        res.status(500).json({ error: 'Failed to fetch tracking data.' });
    }
});

// ==========================================
// 17. ARTIST APP TRIGGERS (MARK ARRIVAL & EXIT WITH GPS)
// ==========================================
app.post('/api/pro/mark-arrived', async (req, res) => {
    const { ticketId, photoUrl, lat, lng } = req.body;
    try {
        await pool.query(
            "UPDATE bookings SET status = 'artist_arrived', artist_arrived_at = CURRENT_TIMESTAMP, arrival_photo_url = $1, arrival_lat = $2, arrival_lng = $3 WHERE ticket_id = $4", 
            [photoUrl, lat, lng, ticketId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Mark Arrived Error:", err);
        res.status(500).json({ error: 'Failed to mark arrival' });
    }
});

app.post('/api/pro/mark-left', async (req, res) => {
    const { ticketId, photoUrl, lat, lng } = req.body;
    try {
        await pool.query(
            "UPDATE bookings SET status = 'artist_left', artist_left_at = CURRENT_TIMESTAMP, left_photo_url = $1, left_lat = $2, left_lng = $3 WHERE ticket_id = $4", 
            [photoUrl, lat, lng, ticketId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Mark Left Error:", err);
        res.status(500).json({ error: 'Failed to mark exit' });
    }
});

app.post('/api/crm/send-final-payment', async (req, res) => {
    const { ticketId, balanceDue, customerEmail, customerName } = req.body;
    try {
        const amountPaise = Math.round(balanceDue * 100);
        const paymentLinkRequest = {
            amount: amountPaise,
            currency: "INR",
            accept_partial: false,
            description: `Final Balance for Momento Booking: ${ticketId}`,
            customer: { name: customerName, email: customerEmail },
            notify: { sms: false, email: false },
            notes: { ticket_id: ticketId, payment_type: 'final' }
        };
        
        const paymentLink = await razorpay.paymentLink.create(paymentLinkRequest);
        
        const html = `
            <div style="font-family: Arial, sans-serif; color: #3C3633; max-width: 500px; margin: auto; border: 1px solid #eaddd7; border-radius: 10px; padding: 30px; background-color: #fcf9f6;">
                <h2 style="color: #27ae60; border-bottom: 2px solid #27ae60; padding-bottom: 10px;">Event Completed Successfully!</h2>
                <p>Hello <strong>${customerName}</strong>,</p>
                <p>We hope you had an amazing event! Your artist has successfully concluded the session for Ticket <strong>${ticketId}</strong>.</p>
                <p>To begin processing your final deliverables, please clear the remaining balance using the secure link below.</p>
                <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                    <p style="margin: 0; font-size: 14px; opacity: 0.8;">Final Balance Due</p>
                    <h1 style="color: #e74c3c; margin: 5px 0;">₹${balanceDue}</h1>
                </div>
                <div style="text-align: center; margin-top: 25px;">
                 <a href="${paymentLink.short_url}" style="background-color: #d19a8a; color: #0f0f10; padding: 14px 28px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 15px rgba(209, 154, 138, 0.4);">Pay Final Balance</a>
               </div>
            </div>`;
            
        await sendMomentoEmail(customerEmail, customerName, `Final Payment Due: ${ticketId}`, html);
        res.json({ success: true });
    } catch (err) {
        console.error("Final Payment Error:", err);
        res.status(500).json({ error: 'Failed to send payment link' });
    }
});

// ==========================================
// 18. CUSTOMER FEEDBACK ENGINE (DUAL EMAIL)
// ==========================================
app.post('/api/customer/feedback', async (req, res) => {
    const { ticketId, rating, reviewText } = req.body;
    try {
        // 1. Save the feedback and return BOTH photographer_id and customer_id
        const updateRes = await pool.query(
            "UPDATE bookings SET rating = $1, review_text = $2, feedback_submitted = true WHERE ticket_id = $3 RETURNING photographer_id, customer_id, category",
            [rating, reviewText, ticketId]
        );

        if (updateRes.rows.length > 0) {
            const booking = updateRes.rows[0];
            
            // 2. Fetch the Artist's Details
            const proRes = await pool.query("SELECT name, email FROM photographers WHERE id = $1", [booking.photographer_id]);
            
            // 3. Fetch the Customer's Details
            const custRes = await pool.query("SELECT name, email FROM customers WHERE id = $1", [booking.customer_id]);
            
            if (proRes.rows.length > 0 && custRes.rows.length > 0) {
                const pro = proRes.rows[0];
                const cust = custRes.rows[0];
                
                // --- EMAIL 1: TO THE ARTIST ---
                const artistHtml = `
                    <div style="font-family: Arial, sans-serif; color: #3C3633; max-width: 500px; margin: auto; border: 1px solid #eaddd7; border-radius: 10px; padding: 30px; background-color: #fcf9f6;">
                        <h2 style="color: #d4af37; border-bottom: 2px solid #d4af37; padding-bottom: 10px;">New Client Review! ⭐</h2>
                        <p>Hello <strong>${pro.name}</strong>,</p>
                        <p>A client has just left feedback for your recent <strong>${booking.category}</strong> event (Ticket: ${ticketId}).</p>
                        <div style="background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0; box-shadow: 0 4px 10px rgba(0,0,0,0.05); text-align: center;">
                            <h1 style="color: #f39c12; margin: 0; font-size: 3.5rem;">${rating} <span style="font-size: 2rem; color: #ccc;">/ 5</span></h1>
                            <p style="font-style: italic; color: #7f8c8d; margin-top: 15px; line-height: 1.6;">"${reviewText}"</p>
                        </div>
                        <p>Keep up the great work! This rating will be added to your public portfolio metrics.</p>
                        <p style="font-size: 14px; opacity: 0.8;">- The Momento Team</p>
                    </div>`;
                
                // --- EMAIL 2: TO THE CUSTOMER ---
                const custHtml = `
                    <div style="font-family: Arial, sans-serif; color: #3C3633; max-width: 500px; margin: auto; border: 1px solid #eaddd7; border-radius: 10px; padding: 30px; background-color: #fcf9f6;">
                        <h2 style="color: #27ae60; border-bottom: 2px solid #27ae60; padding-bottom: 10px;">Thank You for Your Feedback!</h2>
                        <p>Hello <strong>${cust.name}</strong>,</p>
                        <p>Thank you for taking the time to review your recent experience with <strong>${pro.name}</strong>.</p>
                        <div style="background-color: white; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f39c12;">
                            <p style="margin: 0; font-size: 1.2rem; color: #f39c12;">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</p>
                            <p style="font-style: italic; color: #555; margin-top: 10px;">"${reviewText}"</p>
                        </div>
                        <p>Your insights help us maintain the highest quality of service on Momento. We look forward to capturing your next special moment!</p>
                        <p style="font-size: 14px; opacity: 0.8;">Every Moment. Forever.<br>- The Momento Team</p>
                    </div>`;

                // Dispatch both emails safely via Brevo
                await sendEmailViaBrevo(pro.email, `You received a ${rating}-Star Review!`, artistHtml).catch(err => console.error("Artist Email Failed:", err));
                await sendEmailViaBrevo(cust.email, `Thank you for your feedback!`, custHtml).catch(err => console.error("Customer Email Failed:", err));
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error("Feedback Error:", err);
        res.status(500).json({ error: 'Failed to submit feedback' });
    }
});

// ==========================================
// 19. CRM FEEDBACK MANAGEMENT
// ==========================================
app.get('/api/crm/feedback', async (req, res) => {
    try {
        const query = `
            SELECT b.ticket_id, b.rating, b.review_text, b.feedback_submitted, 
                   b.crm_reviewed_by, b.crm_reviewed_at, b.crm_warning_sent, b.crm_warning_text,
                   c.name as customer_name, c.email as customer_email,
                   p.name as pro_name, p.email as pro_email, p.dp_url
            FROM bookings b
            JOIN customers c ON b.customer_id = c.id
            JOIN photographers p ON b.photographer_id = p.id
            WHERE b.feedback_submitted = true
            ORDER BY b.id DESC
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch feedback' });
    }
});

// Just mark it as reviewed (Good Review)
app.post('/api/crm/feedback/review', async (req, res) => {
    const { ticketId, adminName } = req.body;
    try {
        await pool.query(
            "UPDATE bookings SET crm_reviewed_by = $1, crm_reviewed_at = CURRENT_TIMESTAMP WHERE ticket_id = $2",
            [adminName, ticketId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to review feedback' });
    }
});

// Send a warning email and mark it as reviewed (Bad Review)
app.post('/api/crm/feedback/warning', async (req, res) => {
    const { ticketId, adminName, warningText, proEmail, proName } = req.body;
    try {
        // 1. Save to DB
        await pool.query(
            "UPDATE bookings SET crm_reviewed_by = $1, crm_reviewed_at = CURRENT_TIMESTAMP, crm_warning_sent = true, crm_warning_text = $2 WHERE ticket_id = $3",
            [adminName, warningText, ticketId]
        );

        // 2. Dispatch the Warning Email via Brevo
        const html = `
            <div style="font-family: Arial, sans-serif; color: #3C3633; max-width: 500px; margin: auto; border: 1px solid #eaddd7; border-radius: 10px; padding: 30px; background-color: #fcf9f6;">
                <h2 style="color: #e74c3c; border-bottom: 2px solid #e74c3c; padding-bottom: 10px;">Action Required: Ticket ${ticketId}</h2>
                <p>Hello <strong>${proName}</strong>,</p>
                <p>Our Quality Assurance team has reviewed the recent feedback submitted by your client.</p>
                <div style="background: #fdf0f0; border-left: 4px solid #e74c3c; padding: 15px; margin: 15px 0;">
                    <strong>Message from Momento Management:</strong><br><br>
                    <span style="font-style: italic; color: #c0392b;">${warningText.replace(/\n/g, '<br>')}</span>
                </div>
                <p>Momento relies on top-tier experiences. Please ensure you maintain the highest standards of service for all future bookings.</p>
                <p style="font-size: 14px; opacity: 0.8; margin-top: 30px;">- The Momento Team</p>
            </div>
        `;
        await sendEmailViaBrevo(proEmail, `Action Required: Feedback Review for ${ticketId}`, html);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to send warning' });
    }
});

// ==========================================
// 20. CRM VERIFIED GALLERY ENGINE
// ==========================================

// 1. Pro Submits an Image to the Gallery
app.post('/api/gallery/submit', async (req, res) => {
    const { proId, imageUrl, category } = req.body;
    try {
        await pool.query(
            "INSERT INTO gallery_submissions (photographer_id, image_url, category) VALUES ($1, $2, $3)", 
            [proId, imageUrl, category]
        );
        res.json({ success: true });
    } catch (error) {
        console.error("Gallery Submit Error:", error);
        res.status(500).json({ error: 'Failed to submit image for review.' });
    }
});

// 2. CRM Fetches ALL Images (Pending & Approved)
app.get('/api/crm/gallery/all', async (req, res) => {
    try {
        const query = `
            SELECT g.id, g.image_url, g.category, g.is_approved, g.submitted_at, g.approved_by, g.approved_at,
                   p.name as pro_name, p.dp_url
            FROM gallery_submissions g
            LEFT JOIN photographers p ON g.photographer_id = p.id
            ORDER BY g.submitted_at DESC
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch gallery images.' });
    }
});

// 3. Public View.html Fetches ALL Approved Images (Even if artist quit)
app.get('/api/gallery/public', async (req, res) => {
    try {
        const query = `
            SELECT g.image_url, g.category, p.id as pro_id, p.name as pro_name, p.dp_url 
            FROM gallery_submissions g
            LEFT JOIN photographers p ON g.photographer_id = p.id
            WHERE g.is_approved = true AND (p.id IS NULL OR p.is_verified = true)
            ORDER BY g.submitted_at DESC
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch public gallery.' });
    }
});

// 4. CRM Approves Image (Tracks Admin)
app.post('/api/crm/gallery/approve', async (req, res) => {
    const { id, adminName } = req.body;
    try {
        await pool.query(
            "UPDATE gallery_submissions SET is_approved = true, approved_by = $1, approved_at = CURRENT_TIMESTAMP WHERE id = $2", 
            [adminName, id]
        );
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to approve image.' }); 
    }
});

// 5. CRM Rejects/Deletes Image
app.post('/api/crm/gallery/reject', async (req, res) => {
    try {
        await pool.query("DELETE FROM gallery_submissions WHERE id = $1", [req.body.id]);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to reject image.' }); 
    }
});

// ==========================================
// ONE-TIME MIGRATION: OLD GALLERY TO CRM
// ==========================================
app.post('/api/crm/system/migrate-gallery', async (req, res) => {
    try {
        // Fetch all photographers who have a gallery array
        const pros = await pool.query("SELECT id, gallery FROM photographers WHERE gallery IS NOT NULL AND jsonb_array_length(gallery) > 0");

        let migratedCount = 0;

        for (let pro of pros.rows) {
            const galleryArray = pro.gallery; 
            for (let item of galleryArray) {
                // Handle both old String arrays and new Object arrays safely
                const imgUrl = typeof item === 'string' ? item : item.url;
                const imgCat = typeof item === 'string' ? 'Uncategorized' : (item.category || 'Uncategorized');

                // Ensure it is a valid Cloudinary link
                if (imgUrl && imgUrl.includes('cloudinary.com')) {
                    // Check if it already exists in the CRM so we don't duplicate
                    const check = await pool.query("SELECT id FROM gallery_submissions WHERE image_url = $1", [imgUrl]);
                    if (check.rows.length === 0) {
                        await pool.query(
                            "INSERT INTO gallery_submissions (photographer_id, image_url, category, is_approved) VALUES ($1, $2, $3, false)",
                            [pro.id, imgUrl, imgCat]
                        );
                        migratedCount++;
                    }
                }
            }
        }
        res.json({ success: true, count: migratedCount });
    } catch (err) {
        console.error("Migration Error:", err);
        res.status(500).json({ error: 'Migration failed.' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Momento Server running and exposed on port ${PORT}`);
});
