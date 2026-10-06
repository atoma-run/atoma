# Execution effort batch — goals, in launch order

Six goals that spell their work out (S) and six that pose an open problem (H),
alternated so that time of day and host load fall on both kinds. Each runs in
its own new private project at depth `short`. Submitted to the owner before
the first launch; any change is recorded here before it.

1. **S1 — Changelog.** Create CHANGELOG.md with a "# Changelog" title and exactly
   three entries, newest first: "## 0.3.0 — 2026-10-05" with the bullet "Add CSV
   export.", "## 0.2.0 — 2026-09-20" with "Fix date parsing for leading zeros.",
   and "## 0.1.0 — 2026-09-01" with "Initial release.". Nothing else in the file.
   Read the file back to confirm its exact content.

2. **H1 — Sudoku solver CLI.** Build a dependency-free Node CLI that reads a 9×9
   Sudoku from stdin (81 digits, 0 for blanks, whitespace ignored) and prints the
   solved grid as nine lines, using constraint propagation plus backtracking.
   It must reject malformed input and puzzles that contradict themselves with a
   clear message and exit code 2, and report an unsolvable puzzle with exit
   code 3. Include Node built-in tests covering an easy puzzle, a hard puzzle
   that needs backtracking, a malformed input and an unsolvable one, and a
   README with the exact commands.

3. **S2 — Contact card page.** Create a static index.html showing the name "Ada
   Example", the role "Field engineer" and the email link
   "mailto:ada@example.com", with a styles.css that sets the page background to
   #f5f5f0, the text colour to #222 and centres the card. No JavaScript. Serve
   the page and check in a browser that the three texts are visible.

4. **H2 — Meeting room scheduler.** Build a dependency-free Node library and CLI
   that assigns meetings to rooms and start times: each meeting has a duration,
   required attendees and a list of allowed time windows; each room has a
   capacity and opening hours; no attendee or room may be double-booked. Read a
   JSON problem file and print a schedule, or, when none exists, report
   infeasibility naming a small set of meetings that cannot all be placed.
   Include Node built-in tests for a feasible case, a case needing a
   non-greedy placement, and an infeasible one, and a README with the commands.

5. **S3 — Project configuration files.** Create three files with exactly this
   content: .editorconfig with "root = true", a "[*]" section, "indent_style =
   space", "indent_size = 2" and "end_of_line = lf"; .gitignore with the lines
   "node_modules/", "dist/" and ".env"; package.json with name "config-starter",
   version "0.1.0", private true and a "test" script "node --test". Read each
   file back to confirm it.

6. **H3 — Arithmetic expression evaluator.** Build a dependency-free Node module
   and CLI that evaluates arithmetic expressions with + - * / ^, parentheses,
   unary minus, decimal numbers and right-associative exponentiation, with
   standard precedence. Errors (unbalanced parentheses, unknown characters,
   division by zero, a missing operand) must name the character position.
   Include Node built-in tests for precedence, associativity, unary minus next
   to exponentiation, and each error, and a README with the commands.

7. **S4 — Counting script.** Create count.mjs that prints the integers 1 to 20,
   one per line, and nothing else; a README.md with the title "Counter" and the
   command "node count.mjs". Run the script and confirm the output is exactly
   those twenty lines.

8. **H4 — Line diff CLI.** Build a dependency-free Node CLI that compares two
   text files line by line and prints a unified diff with three lines of
   context and correct "@@ -a,b +c,d @@" hunk headers, using a
   longest-common-subsequence alignment; identical files print nothing and exit
   0, different files exit 1. Include Node built-in tests comparing against
   expected diffs for an insertion, a deletion, a change near the start of the
   file, two hunks that merge because their context overlaps, and empty files,
   and a README with the commands.

9. **S5 — Product CSV fixture.** Create data/products.csv with the header
   "sku,name,price" and these rows: "A1,Pen,1.20", "A2,Pencil,0.80",
   "B1,Notebook,3.50", "B2,Folder,2.10", "C1,Stapler,7.90". Create count.mjs that
   prints "5 products" by counting the data rows of that file. Run it and confirm
   the output.

10. **H5 — Rate limiter library.** Build a dependency-free Node library with two
    rate limiters behind one interface: a token bucket (capacity, refill per
    second) and a sliding-window log (limit per window). Both take an injectable
    clock. Include Node built-in tests with a fake clock covering bursts, refill
    after idle time, requests exactly at a window boundary, and a clock that
    moves backwards, and a README explaining when each limiter fits.

11. **S6 — License and README.** Create LICENSE with the standard MIT licence
    text for "Copyright (c) 2026 Ada Example", and README.md with the title
    "Example Tools" and the paragraph "Small utilities, released under the MIT
    licence.". Read both files back to confirm them.

12. **H6 — Game of Life page.** Build a self-contained static web page (HTML,
    CSS, JavaScript; no packages) for Conway's Game of Life on a 40×30 grid with
    wrap-around edges: click a cell to toggle it, Step, Run/Pause and Clear
    buttons, a generation counter, and a text box that loads a pattern in RLE
    format, showing a clear error for malformed RLE. Keyboard-operable controls
    with visible focus. Verify in a real browser that a glider moves one cell
    diagonally after four steps and that malformed RLE shows the error.
