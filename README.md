# MarComms eBlast Calendar

Send calendar for AIA Canada eBlasts, built from the Marketing & Communications Operations — New space in Wrike and checked against the rules in the 2026 email send audit:

- No more than 2 broad sends (1,000+ on the main list) a week; an urgent advisory may take a third slot
- Never two broad sends on the same day
- Reminder series stop at 3 sends: launch, one reminder, last chance (engaged only)
- One monthly partner opportunities email for sponsorship and exhibitor asks

The page is a single static file, `index.html`, served by GitHub Pages. Send data lives in the `RAW` array near the top of the script. Each row is:

`[date, title, program, status (C/A/X), Wrike id, owner, broad 1/0, kind, series, step]`

Updates are made by Claude from Wrike and pushed here.
