#!/usr/bin/env node

/**
 * OpenSciEd → CLUE Curriculum Import Script
 *
 * Parses OpenSciEd lesson Google Docs and generates CLUE curriculum JSON.
 *
 * Usage:
 *   # Single lesson (for testing)
 *   node scripts/import-openscied.js --unit OSEMagnets --doc <docId> --lesson 1
 *
 *   # Multiple lessons via doc ID list
 *   node scripts/import-openscied.js --unit OSEMagnets --docs <id1>,<id2>,...
 *
 *   # Full folder traversal (requires publicly shared folder)
 *   node scripts/import-openscied.js --unit OSEMagnets --folder <folderId>
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// --- Configuration ---

const ICON_ALT_TEXTS = new Set(["turnandtalk", "notebook", "class", "group", "self", "onyourown"]);

const MODEL_KEYWORDS = ["model", "modeling", "draw", "build", "construct", "develop a model"];
const SCI_KEYWORDS = ["scientist", "circle", "consensus", "share", "public record"];

// Activity-type markers that, in some lessons, appear as plain paragraphs
// rather than headings. Treated as section boundaries so a lesson with few
// headings doesn't collapse into a single giant tile.
const ACTIVITY_MARKERS = [
  "turn and talk", "in your notebook", "with your class", "with your group",
  "on your own", "stop and jot", "scientists circle", "individually",
  "as a class", "navigation", "building understandings"
];

const SECTION_DIRS = {
  "whatsgoingon": "whatsgoingon",
  "modelmaking": "modelmaking",
  "scientistscircle": "scientistscircle",
};

// --- Utilities ---

function generateId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let id = "";
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function classifySection(headingText) {
  const lower = headingText.toLowerCase();
  // SCI keywords take precedence (e.g., "consensus model in a Scientists Circle" → SCI not MODEL)
  if (SCI_KEYWORDS.some(kw => lower.includes(kw))) return "scientistscircle";
  if (MODEL_KEYWORDS.some(kw => lower.includes(kw))) return "modelmaking";
  return "whatsgoingon";
}

function isIconImage(img) {
  const alt = (img.attribs?.alt || "").toLowerCase().replace(/\s+/g, "");
  return ICON_ALT_TEXTS.has(alt) || alt === "";
}

function cleanHtml(html) {
  // Strip Google Docs style attributes and classes, keep structural HTML
  return html
    .replace(/\s*class="[^"]*"/g, "")
    .replace(/\s*style="[^"]*"/g, "")
    .replace(/\s*id="[^"]*"/g, "")
    .replace(/<span>(.*?)<\/span>/g, "$1")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Fetching ---

async function fetchDocHtml(docId) {
  const url = `https://docs.google.com/document/d/${docId}/export?format=html`;
  console.log(`  Fetching doc ${docId}...`);
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`Failed to fetch doc ${docId}: ${resp.status}`);
  return resp.text();
}

// List the files/subfolders in a public Google Drive folder by scraping the
// folder's HTML. Each item appears as:
//   data-id="<ID>" jsname="vtaz5c" data-tooltip="<NAME> Google Docs|Slides|..."
// Returns [{ id, name }] where name has the trailing app-type suffix stripped.
async function listFolderFiles(folderId) {
  const url = `https://drive.google.com/drive/folders/${folderId}`;
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`Failed to list folder ${folderId}: ${resp.status}`);
  const html = await resp.text();

  const pat = /data-id="([a-zA-Z0-9_-]+)" jsname="vtaz5c" data-tooltip="([^"]*)"/g;
  const items = [];
  const seen = new Set();
  let m;
  while ((m = pat.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    // Strip the trailing app-type label Drive appends to the tooltip
    const name = m[2]
      .replace(/\s+(Google Docs|Google Slides|Google Sheets|PDF|Google Drive Folder)$/i, "")
      .trim();
    items.push({ id, name });
  }
  return items;
}

// Given the top-level unit folder, discover each lesson's Student Procedure
// and Teacher Edition doc IDs. Returns [{ lessonNum, docId, teacherDocId }]
// ordered by lesson number.
async function discoverLessonDocs(folderId) {
  console.log(`  Listing unit folder ${folderId}...`);
  const topItems = await listFolderFiles(folderId);

  // Lesson subfolders are named "Lesson N - ..."
  const lessonFolders = [];
  for (const item of topItems) {
    const lm = /^Lesson\s+(\d+)\b/i.exec(item.name);
    if (lm) lessonFolders.push({ lessonNum: parseInt(lm[1]), folderId: item.id });
  }
  lessonFolders.sort((a, b) => a.lessonNum - b.lessonNum);
  console.log(`  Found ${lessonFolders.length} lesson folders`);

  const entries = [];
  for (const { lessonNum, folderId: lessonFolderId } of lessonFolders) {
    const files = await listFolderFiles(lessonFolderId);

    // Student Procedure (English, not Spanish)
    const student = files.find(f =>
      /student procedure/i.test(f.name) && !/spanish|lecci[oó]n/i.test(f.name));
    // Teacher Edition
    const teacher = files.find(f =>
      /teacher edition/i.test(f.name) && !/spanish|lecci[oó]n/i.test(f.name));

    if (!student) {
      console.log(`  Lesson ${lessonNum}: no Student Procedure found, skipping`);
      continue;
    }
    entries.push({
      lessonNum,
      docId: student.id,
      teacherDocId: teacher ? teacher.id : null,
    });
    console.log(`  Lesson ${lessonNum}: student=${student.id} teacher=${teacher ? teacher.id : "(none)"}`);
  }
  return entries;
}

// --- Parsing ---

let imageCounter = 0;
let curriculumDirForImages = "";

function saveBase64Image(src, unitCode) {
  const match = src.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return src;
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const data = match[2];
  imageCounter++;
  const filename = `image-${imageCounter}.${ext}`;
  const imagesDir = path.join(curriculumDirForImages, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.writeFileSync(path.join(imagesDir, filename), Buffer.from(data, "base64"));
  return `${unitCode}/images/${filename}`;
}

function parseStudentProcedure(html, lessonNum, unitCode) {
  const $ = cheerio.load(html);
  const body = $("body");

  // Extract lesson title from H1
  const h1 = body.find("h1").first();
  // Strip a redundant leading "Lesson N:" / "Lesson N -" prefix; CLUE already
  // renders the ordinal as "Lesson N" via the termOverrides.
  const lessonTitle = (cleanHtml(h1.text()) || `Lesson ${lessonNum}`)
    .replace(/^Lesson\s+\d+\s*[:\-–—]\s*/i, "")
    .trim() || `Lesson ${lessonNum}`;

  let currentTab = "whatsgoingon";
  const tiles = { whatsgoingon: [], modelmaking: [], scientistscircle: [] };
  const sharedModels = { whatsgoingon: [], modelmaking: [], scientistscircle: [] };

  // Google Docs exports lesson content inside a single large <table>.
  // Extract all content-bearing elements from inside it.
  const mainTable = body.find("table").first();
  const contentRoot = mainTable.length ? mainTable : body;

  // Track elements inside nested data tables so we don't duplicate their text
  const insideDataTable = new Set();
  contentRoot.find("table").each((_, tbl) => {
    if ($(tbl).is(mainTable)) return;
    $(tbl).find("p, h1, h2, h3, h4").each((_, child) => {
      insideDataTable.add(child);
    });
  });

  // Collect all headings, paragraphs, lists, tables, and images in document order
  const elements = contentRoot.find("h1, h2, h3, h4, p, ol, ul, table, img").toArray();
  let currentTextBuffer = [];

  function flushTextBuffer() {
    if (currentTextBuffer.length === 0) return;
    const combined = currentTextBuffer.join("");
    if (combined.trim()) {
      tiles[currentTab].push({
        id: generateId(),
        content: {
          type: "Text",
          format: "html",
          text: [combined]
        }
      });
    }
    currentTextBuffer = [];
  }

  for (const el of elements) {
    const tagName = el.tagName?.toLowerCase();
    const $el = $(el);

    if (tagName === "h1") {
      // Skip — already extracted as lesson title
      continue;
    }

    if (tagName === "h2") {
      if (insideDataTable.has(el)) continue;
      flushTextBuffer();
      const headingText = $el.text().trim();
      if (!headingText) continue;
      currentTab = classifySection(headingText);
      currentTextBuffer.push("<p><strong>" + cleanHtml(headingText) + "</strong></p>");
      continue;
    }

    if (tagName === "h3" || tagName === "h4") {
      if (insideDataTable.has(el)) continue;
      flushTextBuffer();
      const headingText = $el.text().trim();
      if (!headingText) continue;
      currentTextBuffer.push("<p><strong>" + cleanHtml(headingText) + "</strong></p>");
      continue;
    }

    if (tagName === "table") {
      // Skip the outer layout table (we're already inside it via find())
      // Only process nested data tables (tables inside the layout table)
      if ($el.is(mainTable)) continue;

      flushTextBuffer();
      const rows = $el.find("tr").toArray();
      if (rows.length < 2) continue;

      // Detect title row: first row has a single cell spanning all columns
      let tableTitle = "";
      let headerRowIndex = 0;
      const firstRowCells = $(rows[0]).find("td, th").toArray();
      const firstCellColspan = parseInt(firstRowCells[0]?.attribs?.colspan || "1");
      if (firstRowCells.length === 1 && firstCellColspan > 1) {
        tableTitle = cleanHtml($(firstRowCells[0]).text());
        headerRowIndex = 1;
      }

      if (headerRowIndex >= rows.length) continue;
      const headerRow = rows[headerRowIndex];
      const headers = $(headerRow).find("td, th").toArray()
        .map(td => cleanHtml($(td).text()));

      if (headers.length === 0 || headers.every(h => !h)) continue;

      const attributes = headers.map(name => ({
        id: generateId(),
        name: name || "Column",
        hidden: false,
        units: "",
        values: [],
      }));

      const cases = [];
      for (let r = headerRowIndex + 1; r < rows.length; r++) {
        const cells = $(rows[r]).find("td, th").toArray()
          .map(td => cleanHtml($(td).text()));
        for (let c = 0; c < attributes.length; c++) {
          attributes[c].values.push(cells[c] || "");
        }
        cases.push({ __id__: generateId() });
      }

      const tableId = generateId();
      tiles[currentTab].push({
        id: tableId,
        title: tableTitle || headers.join(" / "),
        content: {
          type: "Table",
          columnWidths: {}
        }
      });

      sharedModels[currentTab].push({
        sharedModel: {
          type: "SharedDataSet",
          id: generateId(),
          providerId: tableId,
          dataSet: {
            id: generateId(),
            name: headers.join(" / "),
            attributes,
            cases,
          }
        },
        provider: tableId,
        tiles: [tableId],
      });

      continue;
    }

    if (tagName === "img") {
      if (isIconImage(el)) continue;

      flushTextBuffer();
      const alt = el.attribs?.alt || "Image";
      const src = el.attribs?.src || "";

      if (src) {
        const imgUrl = src.startsWith("data:") ? saveBase64Image(src, unitCode) : src;
        const imgId = generateId();
        tiles[currentTab].push({
          id: generateId(),
          title: alt.substring(0, 50),
          content: {
            type: "Drawing",
            objects: [{
              type: "image",
              id: imgId,
              x: 0, y: 0,
              url: imgUrl,
              width: 400,
              height: 300,
            }]
          },
          layout: { height: 350 }
        });
      }
      continue;
    }

    if (tagName === "p") {
      if (insideDataTable.has(el)) continue;
      const text = $el.text().trim();
      if (!text) continue;
      // Some lessons (e.g. Lesson 3) express activity markers as plain
      // paragraphs rather than headings. Treat a short paragraph beginning with
      // a known activity marker as a section boundary so the lesson doesn't
      // collapse into a single tile. Only re-tab when the marker itself carries
      // a MODEL/SCI keyword; otherwise stay in the current tab.
      const lowerText = text.toLowerCase();
      const isActivityMarker = text.length < 60 &&
        ACTIVITY_MARKERS.some(m => lowerText.startsWith(m));
      if (isActivityMarker) {
        flushTextBuffer();
        const classified = classifySection(text);
        if (classified !== "whatsgoingon") currentTab = classified;
        currentTextBuffer.push("<p><strong>" + cleanHtml($el.html()) + "</strong></p>");
        continue;
      }
      const innerHtml = cleanHtml($el.html());
      if (innerHtml) currentTextBuffer.push("<p>" + innerHtml + "</p>");
      continue;
    }

    if (tagName === "ol" || tagName === "ul") {
      const listHtml = cleanHtml($el.html());
      if (listHtml) {
        currentTextBuffer.push("<" + tagName + ">" + listHtml + "</" + tagName + ">");
      }
      continue;
    }
  }

  flushTextBuffer();

  return { lessonTitle, tiles, sharedModels };
}

// --- Teacher Edition Parsing ---

const SCAFFOLD_KEYWORDS = [
  "supporting students", "additional guidance", "assessment opportunity",
  "alternate activity", "differentiation", "key ideas"
];

function parseTeacherEdition(html, lessonNum) {
  const $ = cheerio.load(html);
  const body = $("body");

  const overviewTiles = [];
  const scaffoldTiles = [];
  let currentTarget = overviewTiles;
  let textBuffer = [];

  function flush() {
    if (textBuffer.length === 0) return;
    const combined = textBuffer.join("");
    if (combined.trim()) {
      currentTarget.push({
        id: generateId(),
        content: { type: "Text", format: "html", text: [combined] }
      });
    }
    textBuffer = [];
  }

  // A line is an "all-caps header" if its letters are predominantly uppercase
  // (e.g. "SUPPORTING STUDENTS IN DEVELOPING AND USING STRUCTURE AND FUNCTION").
  function isAllCapsHeader(text) {
    const stripped = text.replace(/^[✱✓★•\s]+/, "").trim();
    const letters = stripped.replace(/[^A-Za-z]/g, "");
    if (letters.length < 3) return false;
    const uppers = stripped.replace(/[^A-Z]/g, "").length;
    return uppers / letters.length > 0.8;
  }

  // Process the structured content (paragraphs and lists) inside a table cell,
  // converting all-caps lines to bold headers and ✱-prefixed lines to list items.
  function processCellContent($cell) {
    const pieces = [];
    let starItems = []; // buffer for consecutive ✱-prefixed list items

    function flushStars() {
      if (starItems.length === 0) return;
      pieces.push("<ol>" + starItems.map(s => "<li>" + s + "</li>").join("") + "</ol>");
      starItems = [];
    }

    const childEls = $cell.find("p, li, h1, h2, h3, h4").toArray();
    // If the cell has no block children, fall back to its raw text
    if (childEls.length === 0) {
      const raw = cleanHtml($cell.text()).replace(/✱/g, "");
      return raw ? "<p>" + raw + "</p>" : "";
    }

    for (const child of childEls) {
      const childTag = child.tagName?.toLowerCase();
      const rawText = cleanHtml($(child).text());
      if (!rawText) continue;

      const isHeading = /^h[1-4]$/.test(childTag);
      const startsWithStar = /^[✱]/.test(rawText.trim());

      if (isHeading || isAllCapsHeader(rawText)) {
        // Headings and all-caps callouts (often ✱-prefixed) → bold heading
        flushStars();
        const headerText = rawText.replace(/^[✱✓★•\s]+/, "").trim();
        pieces.push("<p><strong>" + headerText + "</strong></p>");
      } else if (startsWithStar) {
        // ✱-bulleted item → ordered list item (strip the star)
        starItems.push(rawText.replace(/^[✱\s]+/, "").trim());
      } else {
        flushStars();
        // Strip inline ✱ footnote markers from regular prose
        pieces.push("<p>" + rawText.replace(/✱/g, "") + "</p>");
      }
    }
    flushStars();
    return pieces.join("");
  }

  // Convert a table to structured HTML, processing each cell's inner content.
  function tableToHtml($table) {
    const rows = $table.find("tr").toArray();
    if (rows.length === 0) return "";

    const parts = [];
    for (const row of rows) {
      for (const cell of $(row).find("td, th").toArray()) {
        const processed = processCellContent($(cell));
        if (processed) parts.push(processed);
      }
    }
    return parts.join("");
  }

  // Walk body children directly (teacher edition is NOT wrapped in one table)
  const elements = body.children().toArray();

  for (const el of elements) {
    const $el = $(el);
    const tagName = el.tagName?.toLowerCase();
    const text = $el.text().trim();

    // The "LEARNING PLAN for LESSON N" H1 marks the boundary between
    // the overview material and the detailed step-by-step scaffolds.
    if (tagName === "h1" && /learning plan/i.test(text)) {
      flush();
      currentTarget = scaffoldTiles;
      textBuffer.push("<p><strong>" + cleanHtml(text) + "</strong></p>");
      continue;
    }

    if (tagName === "h1") {
      // Lesson title — skip (already in unit config)
      continue;
    }

    if (tagName === "h2" || tagName === "h3" || tagName === "h4") {
      if (!text) continue;
      flush();
      textBuffer.push("<p><strong>" + cleanHtml(text) + "</strong></p>");
      continue;
    }

    if (tagName === "table") {
      const tableHtml = tableToHtml($el);
      if (tableHtml) {
        textBuffer.push(tableHtml);
        flush(); // tables get their own tile boundary
      }
      continue;
    }

    if (tagName === "p") {
      if (!text) continue;
      const cleaned = cleanHtml($el.text());
      if (isAllCapsHeader(cleaned)) {
        // Standalone all-caps callout header (e.g. "SUPPORTING STUDENTS IN...")
        flush();
        const headerText = cleaned.replace(/^[✱✓★•\s]+/, "").trim();
        textBuffer.push("<p><strong>" + headerText + "</strong></p>");
      } else {
        textBuffer.push("<p>" + cleanHtml($el.html()).replace(/✱/g, "") + "</p>");
        if (textBuffer.length >= 8) flush();
      }
      continue;
    }

    if (tagName === "ol" || tagName === "ul") {
      textBuffer.push("<" + tagName + ">" + cleanHtml($el.html()) + "</" + tagName + ">");
      continue;
    }

    if (tagName === "hr") {
      flush();
      continue;
    }
  }
  flush();

  return { overviewTiles, scaffoldTiles };
}

// --- Generation ---

function generateUnitConfig(unitCode, unitTitle, lessonCount, sectionTypes) {
  const problems = [];
  for (let i = 1; i <= lessonCount; i++) {
    problems.push({
      description: `Lesson ${i}`,
      ordinal: i,
      title: `Lesson ${i}`,
      subtitle: "",
      disabled: [],
      sections: sectionTypes.map(type =>
        `investigation-0/problem-${i}/${type}/content.json`
      ),
    });
  }

  return {
    code: unitCode,
    abbrevTitle: unitCode,
    appName: "CLUE",
    title: unitTitle,
    subtitle: "OpenSciEd",
    config: {
      placeholderText: "Add tiles here to record your work.",
      autoSectionProblemDocuments: true,
      defaultDocumentType: "problem",
      defaultLearningLogDocument: false,
      disablePublish: ["student"],
      enableHistoryRoles: ["teacher", "student"],
      defaultSharedDocuments: true,
      groupDocumentsEnabled: true,
      toolbar: [
        { id: "Text", title: "Text", isTileTool: true },
        { id: "Table", title: "Table", isTileTool: true },
        { id: "Graph", title: "Graph", isTileTool: true },
        { id: "Drawing", title: "Sketch", isTileTool: true },
        { id: "IframeInteractive", title: "Simulation", isTileTool: true },
      ],
      authorTools: [
        { id: "AI", title: "AI", isTileTool: true },
      ],
      navTabs: {
        showNavPanel: true,
        lazyLoadTabContents: true,
        tabSpecs: [
          {
            tab: "problems",
            label: "Lessons",
            sections: [],
            teacherOnly: false,
          },
          {
            tab: "my-work",
            label: "My Work",
            sections: [
              { title: "Workspaces", type: "problem-documents",
                documentTypes: ["problem"], order: "original" },
            ],
          },
          {
            tab: "sort-work",
            label: "Sort Work",
            teacherOnly: false,
          },
          {
            tab: "teacher-guide",
            label: "Teacher Guide",
            teacherOnly: true,
          },
        ],
      },
      settings: {
        text: {
          tools: ["bold", "italic", "underline", "subscript", "superscript",
                  "heading", "list-ol", "list-ul", "link"],
        },
        table: {
          tools: ["set-expression", "link-tile", "import-data"],
        },
        graph: {
          tools: ["link-tile", "fit-all", "toggle-lock"],
          defaultSeriesLegend: true,
          connectPointsByDefault: true,
        },
        drawing: {
          tools: ["select", "line", "rectangle", "ellipse", "text", "upload",
                  "stroke-color", "fill-color", "duplicate", "delete"],
        },
        iframeInteractive: {
          url: "https://magnets.concord.org",
          interactiveState: {},
          authoredState: {},
          allowedPermissions: "geolocation; microphone; camera; bluetooth",
        },
      },
      enableCommentRoles: ["student", "teacher"],
      termOverrides: {
        "contentLevel.problem": "Lesson",
        "contentLevel.problems": "Lessons",
      },
    },
    sections: {
      whatsgoingon: {
        initials: "WHAT?",
        title: "What's Going On?",
        placeholder: "Record your observations and ideas here.",
      },
      modelmaking: {
        initials: "MODEL",
        title: "Model Making",
        placeholder: "Develop and refine your models here.",
      },
      scientistscircle: {
        initials: "SCI",
        title: "Scientists Circle",
        placeholder: "Share and discuss ideas with your class.",
      },
    },
    planningDocument: {
      enable: "teacher",
      default: false,
    },
    investigations: [
      {
        description: "Forces at a Distance",
        ordinal: 1,
        title: "Forces at a Distance",
        problems,
      },
    ],
  };
}

function generateTeacherGuideConfig(unitCode, lessonCount) {
  const problems = [];
  for (let i = 1; i <= lessonCount; i++) {
    problems.push({
      description: `Lesson ${i}`,
      ordinal: i,
      title: `Lesson ${i}`,
      subtitle: "",
      sections: [
        `investigation-0/problem-${i}/overview/content.json`,
        `investigation-0/problem-${i}/scaffolds/content.json`,
      ],
    });
  }

  return {
    code: unitCode,
    title: `${unitCode} Teacher Guide`,
    sections: {
      overview: { initials: "OV", title: "Overview", placeholder: "Lesson overview" },
      scaffolds: { initials: "SC", title: "Scaffolds", placeholder: "Scaffolding suggestions" },
    },
    investigations: [
      {
        ordinal: 1,
        title: "Forces at a Distance",
        problems,
      },
    ],
  };
}

function generateSectionContent(sectionType, tileData, sectionSharedModels) {
  const tiles = tileData || [];
  const sharedModels = sectionSharedModels || [];

  const content = { tiles };
  if (sharedModels.length > 0) {
    content.sharedModels = sharedModels;
  }

  return {
    type: sectionType,
    content,
  };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1] || "";
      i++;
    }
  }

  const unitCode = flags.unit || "OSEMagnets";
  const unitTitle = flags.title || "How can a magnet move another object without touching it?";
  const sectionTypes = ["whatsgoingon", "modelmaking", "scientistscircle"];

  const curriculumDir = path.join(__dirname, "..", "curriculum", unitCode);
  curriculumDirForImages = curriculumDir;
  imageCounter = 0;

  // Determine which docs to process
  let docEntries = []; // [{docId, lessonNum, teacherDocId}]

  if (flags.doc) {
    const lessonNum = parseInt(flags.lesson) || 1;
    docEntries.push({ docId: flags.doc, lessonNum, teacherDocId: flags.teacherDoc || null });
  } else if (flags.docs) {
    const ids = flags.docs.split(",");
    const teacherIds = flags.teacherDocs ? flags.teacherDocs.split(",") : [];
    docEntries = ids.map((id, i) => ({
      docId: id.trim(),
      lessonNum: i + 1,
      teacherDocId: teacherIds[i] ? teacherIds[i].trim() : null
    }));
  } else if (flags.folder) {
    console.log("Discovering lesson docs by traversing the Drive folder...");
    docEntries = await discoverLessonDocs(flags.folder);
    if (docEntries.length === 0) {
      console.log("No lesson documents found in folder. Check that it is link-shared.");
      process.exit(1);
    }
  } else {
    console.log("Usage:");
    console.log("  node scripts/import-openscied.js --unit OSEMagnets --doc <docId> --lesson 1 [--teacherDoc <id>]");
    console.log("  node scripts/import-openscied.js --unit OSEMagnets --docs <id1>,<id2>,... [--teacherDocs <id1>,<id2>,...]");
    console.log("  node scripts/import-openscied.js --unit OSEMagnets --folder <folderId>");
    process.exit(1);
  }

  console.log(`\nImporting ${docEntries.length} lesson(s) for unit "${unitCode}"...\n`);

  // Process each lesson
  const lessonResults = [];
  for (const { docId, lessonNum, teacherDocId } of docEntries) {
    console.log(`--- Lesson ${lessonNum} ---`);
    const html = await fetchDocHtml(docId);
    const result = parseStudentProcedure(html, lessonNum, unitCode);

    let teacher = null;
    if (teacherDocId) {
      console.log(`  Fetching teacher edition ${teacherDocId}...`);
      const teacherHtml = await fetchDocHtml(teacherDocId);
      teacher = parseTeacherEdition(teacherHtml, lessonNum);
      console.log(`  Teacher tiles: Overview:${teacher.overviewTiles.length} Scaffolds:${teacher.scaffoldTiles.length}`);
    }

    lessonResults.push({ lessonNum, ...result, teacher });

    const tileCount = Object.values(result.tiles).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`  Title: ${result.lessonTitle}`);
    console.log(`  Tiles: ${tileCount} total (WHAT?:${result.tiles.whatsgoingon.length} MODEL:${result.tiles.modelmaking.length} SCI:${result.tiles.scientistscircle.length})`);
  }

  // Update lesson titles in unit config
  const lessonCount = Math.max(...docEntries.map(e => e.lessonNum));

  // Generate unit config
  const unitConfig = generateUnitConfig(unitCode, unitTitle, lessonCount, sectionTypes);
  for (const result of lessonResults) {
    const problem = unitConfig.investigations[0].problems[result.lessonNum - 1];
    if (problem) {
      problem.title = result.lessonTitle;
      problem.description = result.lessonTitle;
    }
  }

  // Write unit config
  fs.mkdirSync(curriculumDir, { recursive: true });
  const unitConfigPath = path.join(curriculumDir, "content.json");
  fs.writeFileSync(unitConfigPath, JSON.stringify(unitConfig, null, 2));
  console.log(`\nWrote ${unitConfigPath}`);

  // Write section content files
  for (const result of lessonResults) {
    for (const sectionType of sectionTypes) {
      const sectionDir = path.join(
        curriculumDir, "investigation-0",
        `problem-${result.lessonNum}`, sectionType
      );
      fs.mkdirSync(sectionDir, { recursive: true });
      const sectionContent = generateSectionContent(sectionType, result.tiles[sectionType], result.sharedModels[sectionType]);
      const sectionPath = path.join(sectionDir, "content.json");
      fs.writeFileSync(sectionPath, JSON.stringify(sectionContent, null, 2));
    }
    console.log(`Wrote sections for Lesson ${result.lessonNum}`);
  }

  // Generate teacher guide config (empty sections for now)
  const tgDir = path.join(curriculumDir, "teacher-guide");
  fs.mkdirSync(tgDir, { recursive: true });
  const tgConfig = generateTeacherGuideConfig(unitCode, lessonCount);
  fs.writeFileSync(path.join(tgDir, "content.json"), JSON.stringify(tgConfig, null, 2));

  // Write teacher guide section files (parsed content where available, else empty)
  for (let i = 1; i <= lessonCount; i++) {
    const lessonResult = lessonResults.find(r => r.lessonNum === i);
    const teacher = lessonResult?.teacher;
    const tgTiles = {
      overview: teacher ? teacher.overviewTiles : [],
      scaffolds: teacher ? teacher.scaffoldTiles : [],
    };
    for (const tgSection of ["overview", "scaffolds"]) {
      const tgSectionDir = path.join(
        tgDir, "investigation-0", `problem-${i}`, tgSection
      );
      fs.mkdirSync(tgSectionDir, { recursive: true });
      const content = { type: tgSection, content: { tiles: tgTiles[tgSection] } };
      fs.writeFileSync(path.join(tgSectionDir, "content.json"), JSON.stringify(content, null, 2));
    }
  }
  console.log(`Wrote teacher guide structure`);

  console.log(`\nDone! Unit "${unitCode}" generated at ${curriculumDir}`);
  console.log(`\nTo test in CLUE:`);
  console.log(`  http://localhost:8080/?unit=${unitCode}&problem=1.1`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
