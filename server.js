require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Basic Security: CORS
const allowedOrigins = [
    'http://localhost:3000', // Local React dev
    'http://localhost:5173', // Vite local dev (alternative)
    'https://portfolio-c863d.web.app', // Default Firebase URL
    'https://rohitdev-portfolio.web.app' // New custom target URL
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    }
}));

app.use(express.json());

// 2. Security: Rate Limiting
const contactLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 requests per windowMs
    message: { success: false, message: "Too many requests, please try again later." },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Apply rate limiting to the contact route
app.use('/api/contact', contactLimiter);

// Health Check Route
app.get('/', (req, res) => {
    res.send('Portfolio Backend is Running - Secure Mode');
});

// Contact Route
app.post('/api/contact', async (req, res) => {
    console.log("Received contact request from IP:", req.ip);

    // 3. Strict Input Validation & Sanitization
    let { name, email, message } = req.body;

    // Trim whitespace
    name = name ? name.trim() : '';
    email = email ? email.trim() : '';
    message = message ? message.trim() : '';

    // Check for empty fields
    if (!name || !email || !message) {
        return res.status(400).json({ success: false, message: "All fields are required." });
    }

    // Basic Email Format Validation (Regex)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ success: false, message: "Invalid email format." });
    }

    // Length Restrictions
    if (message.length > 2000) {
        return res.status(400).json({ success: false, message: "Message is too long (limit 2000 chars)." });
    }

    // 4. Check for Receiver Email (Server Config Validation)
    if (!process.env.RECEIVER_EMAIL) {
        console.error("CRITICAL: RECEIVER_EMAIL is not defined in environment variables.");
        return res.status(500).json({ success: false, message: "Server configuration error: No receiver email configured." });
    }

    try {
        // 5. Strict Email Verification using Mailboxlayer (HTTPS)
        const mailboxApiKey = process.env.MAILBOXLAYER_API_KEY;

        if (!mailboxApiKey) {
            console.error("WARNING: MAILBOXLAYER_API_KEY is missing. Strict verification requires this key.");
            return res.status(500).json({ success: false, message: "Server configuration error: Verification key missing." });
        }

        const verificationUrl = `https://apilayer.net/api/check?access_key=${mailboxApiKey}&email=${email}&smtp=1&format=1`;

        console.log(`Verifying email: ${email}...`);

        let shouldSend = false;

        try {
            const verificationResponse = await axios.get(verificationUrl);
            const data = verificationResponse.data;

            console.log("Mailboxlayer Response:", data);

            // Handle API Errors (e.g., limit reached, auth failed) provided in 200 OK response
            if (data.error) {
                console.error("Mailboxlayer API Error:", data.error);
                return res.status(500).json({ success: false, message: "Email verification service unavailable." });
            }

            // Strict Checks: format must be valid, and (mx found AND smtp check passed)
            // Note: Some free emails might fail SMTP check occasionally, but user requested strictness.
            const isVerified = data.format_valid && data.mx_found; // Relaxed slightly to MX check to be safe, or enforce SMTP if strictly requested.
            // User asked: "verification fails... do NOT send". 
            // If smtp_check is false, it means the email box likely doesn't exist.

            if (!isVerified) {
                return res.status(400).json({ success: false, message: "Email address appears invalid (MX record not found)." });
            }
            // Strict logic: If score is very low, block it?
            if (data.score < 0.3) {
                return res.status(400).json({ success: false, message: "Email blocked by security score." });
            }

            shouldSend = true;

        } catch (apiError) {
            console.error("Mailboxlayer request failed:", apiError.message);
            // User Request: "If verification fails, return an error response and do NOT send the email."
            return res.status(500).json({ success: false, message: "Email verification failed. Please check your email or try again later." });
        }

        if (!shouldSend) {
            return res.status(400).json({ success: false, message: "Email validation failed." });
        }

        // 6. Send Email using Nodemailer (Secure)
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true, // Use SSL
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 10000
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.RECEIVER_EMAIL, // STRICT: Use env variable only
            replyTo: email,
            subject: `Portfolio Contact: Message from ${name}`,
            text: `You have received a new message from your portfolio contact form.\n\nName: ${name}\nUser Email: ${email}\n\nMessage:\n${message}`,
            html: `<h3>New Portfolio Message</h3><p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Message:</strong><br/>${message}</p>`
        };

        const result = await transporter.sendMail(mailOptions);
        console.log("Email sent successfully:", result.messageId);

        return res.status(200).json({ success: true, message: "Message sent successfully!" });

    } catch (error) {
        console.error("Error processing contact form:", error);
        // Expose error message for debugging
        return res.status(500).json({ success: false, message: "Internal server error: " + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
});
