#!/usr/bin/node

// to run this script type the following in the terminal
// cf. https://stackoverflow.com/a/66626333/16328462
// $ cd scripts
// $ node --loader ts-node/esm update-curriculum-to-use-external-problem-sections.ts

import * as fs from "fs";
import stringify from "json-stringify-pretty-compact";

const copyDir = (src: string, dest: string) => {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest);
  }
  const files = fs.readdirSync(src);
  for (const file of files) {
    const srcFile = `${src}/${file}`;
    const destFile = `${dest}/${file}`;
    const stats = fs.statSync(srcFile);
    if (stats.isDirectory()) {
      copyDir(srcFile, destFile);
    } else {
      fs.copyFile(srcFile, destFile, (err) => {
        if (err) {  throw err; }
      });
    }
  }
};

/* 
 * Iterates over unit content and updates any inline problem sections by
 * copying their data to a new external file and replacing the inline
 * data with a reference the external file.
 */
const processProblemSections = (content: any, subdir: string) => {
  const curriculumCode = content.code;
  let sectionFileCount = 0;
  for (const investigation of content.investigations) {
    const investigationOrdinal = investigation.ordinal;
    // make directory for investigation if it doesn't exist
    const investigationDir = `${subdir}/investigation-${investigationOrdinal}`;
    if (!fs.existsSync(investigationDir)) {
      fs.mkdirSync(investigationDir);
    }
    for (const problem of investigation.problems) {
      const problemOrdinal = problem.ordinal;
      // make a directory for problem if it doesn't exist
      const problemDir = `${investigationDir}/problem-${problemOrdinal}`;
      if (!fs.existsSync(problemDir)) {
        fs.mkdirSync(problemDir);
      }
      for (let i = 0; i < problem.sections.length; i++) {
        const section = problem.sections[i];
        const sectionDir = `${problemDir}/${section.type}`;
        if (!fs.existsSync(sectionDir)) {
          fs.mkdirSync(sectionDir);
        }
        if (typeof section !== "string") { // don't update if it's already a reference to an external file
          const sectionFilePath = `${sectionDir}/content.json`;
          const sectionFilePathForContent = sectionFilePath.replace(`${subdir}/`, "");
          const sectionData = section;
          fs.writeFileSync(sectionFilePath, stringify(sectionData, {maxLength: 300}));
          sectionFileCount++;
          problem.sections[i] = `${sectionFilePathForContent}`;
        }
      }
    }
  }
  console.log(`${sectionFileCount} section files added to ${curriculumCode}`);
  return content;
};

const curriculumDir = "../curriculum";
const curriculumSubdirs = fs.readdirSync(curriculumDir).filter(name => !name.endsWith(".json"));
// If you're only updating a specific unit, add its directory name to this array (e.g. "bio4community")
const onlyUpdateUnits: string[] = [];

for (const subdirName of curriculumSubdirs) {
  if (onlyUpdateUnits.length === 0 || onlyUpdateUnits.includes(subdirName)) {
    const subdir = `${curriculumDir}/${subdirName}`;
    const files = fs.readdirSync(subdir).filter(name => name.toLowerCase().endsWith(".json"));
    let assetsProcessed = false;

    for (const filename of files) {
      const isTeacherGuide = filename.toLowerCase().includes("-teacher-guide");
      const fileContent = fs.readFileSync(`${subdir}/${filename}`, "utf8");
      const fileData = JSON.parse(fileContent);
      const curriculumCode = fileData.code;
      let newDirectory = `${curriculumDir}/alpha/${curriculumCode}`;
      if (!fs.existsSync(newDirectory)) {
        fs.mkdirSync(newDirectory);
      }
      if (isTeacherGuide) {
        newDirectory = `${newDirectory}/teacher-guide`;
        if (!fs.existsSync(newDirectory)) {
          fs.mkdirSync(newDirectory);
        }
      }
      // write data to new file
      const updatedFileData = processProblemSections(fileData, newDirectory);
      fs.writeFileSync(`${newDirectory}/content.json`, stringify(updatedFileData, {maxLength: 300}));

      // copy any assets
      if (!isTeacherGuide && !assetsProcessed) {
        const imagesDir = `${subdir}/images`;
        if (fs.existsSync(imagesDir)) {
          copyDir(imagesDir, `${newDirectory}/images`);
        }
        const stampsDir = `${subdir}/stamps`;
        if (fs.existsSync(stampsDir)) {
          copyDir(stampsDir, `${newDirectory}/stamps`);
        }
        assetsProcessed = true;
      }
    }
  }
}
