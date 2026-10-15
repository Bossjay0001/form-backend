require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Resend } = require('resend');
const { GoogleGenAI } = require('@google/genai');

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() }) : null;

const app = express();
const PORT = process.env.PORT || 5000;

// Multer memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Cloudinary setup
const hasCloudinary = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET;
if (hasCloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

// Resend setup
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-migration: Ensure required columns exist and drop strict constraints
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS furniture_leads (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255),
        email VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS phone_number VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS phone VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS location VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS category VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS furniture_type VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS material VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS dimensions TEXT;
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS details TEXT;
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS image_url TEXT;

      -- Drop strict NOT NULL constraints on optional columns if present
      ALTER TABLE furniture_leads ALTER COLUMN furniture_type DROP NOT NULL;
      ALTER TABLE furniture_leads ALTER COLUMN phone_number DROP NOT NULL;
    `);
    console.log('✅ PostgreSQL schema verified and synced successfully.');
  } catch (err) {
    console.log('ℹ️ Database sync check finished.');
  }
}
initDatabase();

// Health Check
app.get('/', (req, res) => {
  res.send('Custom Furniture API Backend is running.');
});

// Lead Submission Endpoint
app.post('/api/leads', upload.single('referenceImage'), async (req, res) => {
  try {
    const { 
      fullName, full_name,
      email, 
      phone, contact_info, phone_number,
      location, 
      category, furniture_type, furnitureType,
      material, 
      dimensions, 
      details 
    } = req.body;

    const clientName = fullName || full_name || 'Anonymous';
    const clientContact = phone || contact_info || phone_number || 'N/A';
    const furnitureCategory = category || furniture_type || furnitureType || 'Custom Furniture';
    let imageUrl = null;

    // Image Upload to Cloudinary
    if (req.file && hasCloudinary) {
      try {
        const uploadPromise = new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: 'furniture_leads' },
            (error, result) => {
              if (error) reject(error);
              else resolve(result.secure_url);
            }
          );
          stream.end(req.file.buffer);
        });
        imageUrl = await uploadPromise;
      } catch (uploadErr) {
        console.error('⚠️ Cloudinary upload skipped/failed:', uploadErr);
      }
    }

    // Insert Lead into PostgreSQL with fallbacks for furniture_type and phone_number
    const query = `
      INSERT INTO furniture_leads 
      (full_name, email, phone_number, location, category, furniture_type, material, dimensions, details, image_url, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *;
    `;
    const values = [
      clientName, 
      email || null, 
      clientContact, 
      location || null, 
      furnitureCategory, 
      furnitureCategory, 
      material || null, 
      dimensions || null, 
      details || null, 
      imageUrl
    ];

    const result = await pool.query(query, values);

    // Send email notification via Resend
    if (resend) {
      try {
        await resend.emails.send({
          from: 'Furniture Leads <onboarding@resend.dev>',
          to: process.env.ADMIN_EMAIL || email,
          subject: `New Custom Furniture Quote Request - ${clientName}`,
          html: `
            <h3>New Lead Received</h3>
            <p><strong>Name:</strong> ${clientName}</p>
            <p><strong>Email:</strong> ${email || 'N/A'}</p>
            <p><strong>Phone/WhatsApp:</strong> ${clientContact}</p>
            <p><strong>Location:</strong> ${location || 'N/A'}</p>
            <p><strong>Category:</strong> ${furnitureCategory}</p>
            <p><strong>Material Finish:</strong> ${material || 'Unspecified'}</p>
            <p><strong>Dimensions:</strong> ${dimensions || 'N/A'}</p>
            <p><strong>Details:</strong> ${details || 'N/A'}</p>
            ${imageUrl ? `<p><strong>Reference Image:</strong> <a href="${imageUrl}" target="_blank">View Reference Image</a></p>` : ''}
          `
        });
      } catch (emailErr) {
        console.error('⚠️ Resend email failed:', emailErr);
      }
    }

    res.status(200).json({ success: true, lead: result.rows[0] });
  } catch (error) {
    console.error('❌ Lead processing error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// AI Interior Design & Pricing Assistant Endpoint (With Memory & Auto-Fallback)
app.post('/api/chat', async (req, res) => {
  try {
    if (!ai) {
      return res.status(503).json({ reply: 'Our AI assistant is currently offline. Please use the WhatsApp button to chat with us directly!' });
    }

    const { message, history = [] } = req.body;
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ reply: 'Please enter a message.' });
    }
    if (!Array.isArray(history) || history.some(item =>
      !item || !['user', 'ai'].includes(item.role) || typeof item.text !== 'string'
    )) {
      return res.status(400).json({ reply: 'Invalid chat history.' });
    }

    const systemPrompt = `
      You are the Lead AI Interior Design & Pricing Consultant for "BossJay Luxe", a luxury bespoke furniture and interior craftsmanship brand in Nigeria.

      DETAILED PRICING & SIZING GUIDE (In Naira ₦):
      1. Custom Media Centers & TV Consoles:
         - Compact / Floating Console (4ft - 6ft): ₦250,000 – ₦380,000
         - Standard Fluted Wall Unit with LED & Marble Board (6ft - 8ft): ₦400,000 – ₦650,000
         - Grand Floor-to-Ceiling Wall-to-Wall Entertainment Center (8ft - 12ft+): ₦700,000 – ₦1,200,000+
      2. Fitted Master Wardrobes & Walk-In Closets:
         - 2-Door / 4ft-6ft Fitted Wardrobe (Egger/MDF board): ₦300,000 – ₦480,000
         - 3-to-4 Door Floor-to-Ceiling Wardrobe (6ft-8ft with mirrors/LEDs): ₦500,000 – ₦850,000
         - Luxury Smoked Glass / Aluminum Frame or Walk-In Closet System: ₦900,000 – ₦1,800,000+
      3. Bespoke Sofas & Lounge Sectionals:
         - Statement Loveseat / 3-Seater Sofa: ₦500,000 – ₦750,000
         - L-Shaped Family Sectional (Velvet, Bouclé, or Linen): ₦650,000 – ₦1,100,000
         - Full U-Shaped Luxury Lounge or Genuine Leather Set: ₦1,200,000 – ₦2,200,000+
      4. Dining Sets & Custom Tables:
         - 4-Seater Dining Set: ₦350,000 – ₦500,000
         - 6-Seater Hardwood or Marble-Top Dining Set: ₦550,000 – ₦950,000
         - 8-Seater Grand Marble / Sintered Stone Dining Set: ₦1,000,000 – ₦1,800,000+

      MATERIALS & CRAFTSMANSHIP:
      - Woods & Boards: Seasoned Nigerian Teak, Mahogany, Oak, Walnut, and high-density moisture-resistant Egger/MDF boards.
      - Fabrics & Foams: High-density orthopedic foam (zero sagging guarantee), stain-resistant velvet, bouclé, suede, and top-grain leather.
      - Finishes: Sintered stone, Carrara marble slabs, gold brushed stainless steel, tinted glass, and motion-sensor warm LED lighting.

      DELIVERY & TIMELINE:
      - Production time: 2 to 4 weeks depending on custom specifications.
      - Nationwide delivery & professional installation across Nigeria (Port Harcourt / Rivers State, Abia, Lagos, Abuja, Enugu, Delta, Imo, Owerri, etc.).
      - Direct WhatsApp: +234 902 208 4197.

      YOUR PERSONALITY & RULES:
      - Be conversational, smart, warm, and helpful. Remember what the client said earlier in the chat.
      - If a user says "Hi" or greets you, welcome them warmly and ask what room or furniture piece they are planning to build.
      - When they give dimensions (like "6 by 4 feet wardrobe"), calculate a tailored estimate right away based on the pricing guide above and suggest 1 or 2 material options (e.g., matte board vs. sliding mirror doors).
      - Ask a helpful follow-up question (like their preferred color tone, state for delivery, or if they want LED lighting) to keep the conversation flowing naturally.
    `;

    const conversationContents = [
      ...history.map(item => ({
        role: item.role === 'ai' ? 'model' : 'user',
        parts: [{ text: item.text }]
      })),
      { role: 'user', parts: [{ text: message.trim() }] }
    ];

    const modelsToTry = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'];
    let replyText = null;
    let lastError = null;

    for (const modelName of modelsToTry) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: conversationContents,
          config: {
            systemInstruction: systemPrompt,
          }
        });
        replyText = response.text;
        if (replyText) break;
      } catch (err) {
        console.warn(`⚠️ Model ${modelName} busy/failed, trying fallback...`, err.status || err.message);
        lastError = err;
      }
    }

    if (!replyText) {
      throw lastError || new Error('All AI models busy');
    }

    res.json({ reply: replyText });
  } catch (error) {
    console.error('❌ AI Chat error:', error);
    res.status(500).json({ reply: 'I am experiencing high traffic right now. Please try sending your message again in a few seconds, or tap the WhatsApp button!' });
  }
});

// Start Server (Must be at the very bottom of server.js!)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});