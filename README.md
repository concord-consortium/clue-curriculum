# CLUE Curriculum

This is a repository for CLUE curriculum unit and teacher guide data. The unit and teacher guide data is imported by [CLUE](https://github.com/concord-consortium/collaborative-learning).

## Adding a Unit

To add a new unit, first decide on a unit code. For example, the existing unit _Stretching and Shrinking_ uses the code `sas`. Next, create a new subdirectory in the curriculum directory using that code as a name. In that new subdirectory, add a file named `content.json`. Use the unit-template.json file as a starting place to build the new file's content.

### Problem Sections
Curriculum units contain a number of investigations. Each investigation contains a number of problems, and each problem has a number of sections. The content for these problem sections is located in files separate from the unit's main content.json file.

Each problem section should have its own content.json file located in a subdirectory of the unit directory. The file structure is generally:

-- unit
---- content.json
---- investigation-1
------ problem-1
-------- section-1-type
---------- content.json
-------- section-2-type
---------- content.json
------ problem-2
-------- section-1-type
---------- content.json

Note that each problem section's directory name should match the section's type. So if the problem section's type is `introduction`, its directory name should be `introduction`.

Use the problem-section-template.json file as a starting place to build a problem section's content.json file. To populate the `tiles` array with the tiles that should appear in the section, first create the tiles in CLUE, then use CLUE's export/copy-to-clipboard feature to gather the tile's JSON, and then add it to the the `tiles` array.

The unit's root content.json file references the separate problem section files using relative paths. These paths are used by CLUE to import the problem sections when loading the unit content.

## Adding a Teacher Guide

In an existing unit directory, add a subdirectory named `teacher-guide`. The teacher guide should have it's own content.json file added to that subdirectory. If the teacher guide contains problem sections, they should go into separate files in the teacher-guide directory, following the same pattern that the main unit uses.
