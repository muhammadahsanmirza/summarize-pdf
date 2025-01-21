const express = require("express");
const dotenv = require("dotenv");
const pdfParse = require("pdf-parse");
const multer = require("multer");
const path = require("path");
const fs = require("fs").promises;
const { OpenAI } = require("openai");

const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const openai = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
});

async function checkSupabaseConnection() {
  try {
    const { data, error } = await supabase
      .from("summaries")
      .select("*")
      .limit(1);
    if (error) {
      console.error("Supabase connection error:", error);
      return false;
    }
    console.log("Supabase connected successfully!");
    return true;
  } catch (err) {
    console.error("Error checking Supabase connection:", err);
    return false;
  }
}

const app = express();
const port = 3000;

const upload = multer({ dest: "uploads/" });
async function extractTextFromPDF(filePath) {
  const dataBuffer = await fs.readFile(filePath);
  const data = await pdfParse(dataBuffer);
  return data.text;
}

function segmentIntoChapters(text) {
  const chapters = text.split(/Chapter \d+/i);
  return chapters.filter((chapter) => chapter.trim() !== "");
}

async function getSummaryFromDeepSeek(text) {
  const prompt = `
  Evaluate provided chapter content and existing cards for adherence to the 5C principles: Clarity, Cohesion, Coverage (ensure most but not all vital points are included), Granularity, and Storytelling.
  - **Clarity**: Ensure language is clear and straightforward.
  - **Cohesion**: Confirm there's a logical flow between ideas.
  - **Coverage**: Check that most vital points are included, not all.
  - **Granularity**: Maintain an appropriate level of detail.
  - **Storytelling**: Ensure a natural, engaging narrative is present.

  # Steps

  1. Review existing cards against the 5C principles.
  2. Identify where each card meets or falls short of these principles.
  3. If a card meets all criteria, output "PASS".
  4. Otherwise, suggest improvements to the existing cards.
  5. Evaluate chapter content to identify any important topics that have been missed.

  Return the summary and the evaluation scores in the following JSON format:
{
  "summary": "The generated summary text...",
  "clarity_score": 9,
  "cohesion_score": 8,
  "coverage_score": 7,
  "granularity_score": 8,
  "storytelling_score": 9,
  "overall_score": 9
}
  `;

  const response = await openai.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: text },
    ],
  });

  // Extract the response text
  const responseText = response.choices[0].message.content;

  // Remove Markdown syntax (e.g., ```json and ```)
  const cleanedResponse = responseText.replace(/```json|```/g, "").trim();

  // Parse the cleaned response into a JSON object
  try {
    const result = JSON.parse(cleanedResponse);
    return result;
  } catch (error) {
    console.error("Error parsing API response:", error);
    console.error("Response text:", cleanedResponse);
    throw new Error("Failed to parse API response.");
  }
}

async function storeSummaryInSupabase(
  chapterNumber,
  summary,
  clarityScore,
  cohesionScore,
  coverageScore,
  granularityScore,
  storytellingScore,
  overallScore
) {
  const { data, error } = await supabase.from("summaries").insert([
    {
      chapter_number: chapterNumber,
      summary: summary,
      clarity_score: clarityScore,
      cohesion_score: cohesionScore,
      coverage_score: coverageScore,
      granularity_score: granularityScore,
      storytelling_score: storytellingScore,
      overall_score: overallScore,
    },
  ]);

  if (error) {
    console.error("Supabase error:", error);
    throw new Error(`Supabase error: ${error.message}`);
  }

  return data;
}

app.post("/upload", upload.single("book"), async (req, res) => {
  try {
    const filePath = req.file.path;

    // Extract text from PDF
    const text = await extractTextFromPDF(filePath);

    // Segment text into chapters
    const chapters = segmentIntoChapters(text);

    // Process each chapter
    for (let i = 0; i < chapters.length; i++) {
      console.log(`Processing Chapter ${i + 1}...`);

      // Get summary and scores from DeepSeek
      const {
        summary,
        clarity_score,
        cohesion_score,
        coverage_score,
        granularity_score,
        storytelling_score,
        overall_score,
      } = await getSummaryFromDeepSeek(chapters[i]);

      // Store summary and scores in Supabase
      await storeSummaryInSupabase(
        i + 1,
        summary,
        clarity_score,
        cohesion_score,
        coverage_score,
        granularity_score,
        storytelling_score,
        overall_score
      );

      console.log(`Chapter ${i + 1} summary and scores stored in Supabase.`);
    }

    // Delete the uploaded file after processing
    await fs.unlink(filePath);

    res.status(200).json({ message: "Book processed successfully!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "An error occurred while processing the book." });
  }
});
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true })); // Increase URL-encoded payload limit
// Start the server
app.listen(port, async () => {
  console.log(`Server running on http://localhost:${port}`);

  const isSupabaseConnected = await checkSupabaseConnection();
  if (!isSupabaseConnected) {
    console.error("Failed to connect to Supabase. Exiting...");
    process.exit(1);
  }
});
