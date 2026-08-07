import { describe, expect, test } from "bun:test";

import { parseReviewDiffSnapshot } from "../src/diff";

describe("parseReviewDiffSnapshot", () => {
  test("preserves quoted rename paths and exact old/new source anchors", () => {
    const snapshot =
      parseReviewDiffSnapshot(`diff --git "a/old name.ts" "b/new name.ts"
similarity index 80%
rename from old name.ts
rename to new name.ts
--- "a/old name.ts"
+++ "b/new name.ts"
@@ -7,3 +7,3 @@ function example()
 retained();
-oldCall();
+newCall();
`);

    expect(snapshot.files).toHaveLength(1);
    const [file] = snapshot.files;
    expect(file).toMatchObject({
      path: "new name.ts",
      oldPath: "old name.ts",
      newPath: "new name.ts",
      occurrence: 1,
      linesAdded: 1,
      linesRemoved: 1,
    });
    expect(file?.rows.filter((row) => row.kind === "removed")).toEqual([
      {
        kind: "removed",
        raw: "-oldCall();",
        content: "oldCall();",
        oldLine: 8,
        hunkHeader: "@@ -7,3 +7,3 @@ function example()",
      },
    ]);
    expect(file?.rows.filter((row) => row.kind === "added")).toEqual([
      {
        kind: "added",
        raw: "+newCall();",
        content: "newCall();",
        newLine: 8,
        hunkHeader: "@@ -7,3 +7,3 @@ function example()",
      },
    ]);
  });

  test("uses unquoted marker paths with spaces, tab suffixes, and end-of-line markers", () => {
    const snapshot =
      parseReviewDiffSnapshot(`diff --git a/docs/old note.md b/docs/new note.md
--- a/docs/old note.md\t2026-08-07 10:00:00
+++ b/docs/new note.md
@@ -1 +1 @@
-before
+after
`);

    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]).toMatchObject({
      path: "docs/new note.md",
      oldPath: "docs/old note.md",
      newPath: "docs/new note.md",
    });
  });

  test("excludes only complete generated paths instead of similarly named source paths", () => {
    const snapshot =
      parseReviewDiffSnapshot(`diff --git a/dist/bundle.js b/dist/bundle.js
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1 +1 @@
-old
+new
diff --git a/src/dist/bundle.js b/src/dist/bundle.js
--- a/src/dist/bundle.js
+++ b/src/dist/bundle.js
@@ -1 +1 @@
-old
+new
`);

    expect(snapshot.excluded).toEqual([
      { path: "dist/bundle.js", reason: "build output" },
    ]);
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]?.path).toBe("src/dist/bundle.js");
  });

  test("keeps staged and unstaged occurrences of the same path independently", () => {
    const snapshot =
      parseReviewDiffSnapshot(`diff --git a/src/repeated.ts b/src/repeated.ts
--- a/src/repeated.ts
+++ b/src/repeated.ts
@@ -1 +1 @@
-before-staged
+after-staged
diff --git a/src/repeated.ts b/src/repeated.ts
--- a/src/repeated.ts
+++ b/src/repeated.ts
@@ -4 +4 @@
-before-unstaged
+after-unstaged
`);

    expect(
      snapshot.files.map((file) => ({
        path: file.path,
        occurrence: file.occurrence,
      })),
    ).toEqual([
      { path: "src/repeated.ts", occurrence: 1 },
      { path: "src/repeated.ts", occurrence: 2 },
    ]);
    expect(
      snapshot.files[0]?.rows.find((row) => row.kind === "added"),
    ).toMatchObject({
      content: "after-staged",
      newLine: 1,
    });
    expect(
      snapshot.files[1]?.rows.find((row) => row.kind === "added"),
    ).toMatchObject({
      content: "after-unstaged",
      newLine: 4,
    });
  });

  test("retains binary and rename-only files as navigable file entries", () => {
    const snapshot =
      parseReviewDiffSnapshot(`diff --git a/assets/data.bin b/assets/data.bin
index 1111111..2222222 100644
Binary files a/assets/data.bin and b/assets/data.bin differ
diff --git a/src/previous.ts b/src/current.ts
similarity index 100%
rename from src/previous.ts
rename to src/current.ts
`);

    expect(snapshot.files).toHaveLength(2);
    expect(snapshot.files[0]).toMatchObject({
      path: "assets/data.bin",
      isBinary: true,
      rows: [],
    });
    expect(snapshot.files[1]).toMatchObject({
      path: "src/current.ts",
      oldPath: "src/previous.ts",
      newPath: "src/current.ts",
      isBinary: false,
      rows: [],
    });
  });
});
