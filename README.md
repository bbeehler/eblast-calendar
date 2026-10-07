# MarComms eBlast Calendar

Live send calendar for AIA Canada eBlasts, pulled from the **Marketing & Communications Operations — New** space in Wrike and checked against the rules in the 2026 email send audit:

- No more than 2 broad sends (1,000+ on the main list) a week; an urgent advisory may take a third slot
- Never two broad sends on the same day
- Reminder series stop at 3 sends: launch, one reminder, last chance (engaged only)
- One monthly partner opportunities email for sponsorship and exhibitor asks

Site: https://bbeehler.github.io/eblast-calendar/

## How it updates

`.github/workflows/refresh.yml` runs every 15 minutes, on every push to `main`, and from the **Run workflow** button on the Actions tab. Each run:

1. Runs `scripts/refresh.mjs`, which calls the Wrike API with the `WRIKE_TOKEN` secret and pulls every task with "blast" in its title, plus eBlast projects that have no separate send task.
2. Writes `data.json` and commits it only when the sends changed.
3. Publishes `index.html`, `data.json` and a `checked.json` timestamp to GitHub Pages.

The open page checks for new data every 5 minutes and reloads itself when something changed.

### Refresh from Wrike button

The button on the page calls a Supabase Edge Function, `eblast-refresh` in the **AIA Canada Data Portal** project (source in `supabase/functions/eblast-refresh`). The function starts the workflow above and reports its progress. It only accepts calls from `bbeehler.github.io` and won't start a new run while one is running or within 2 minutes of the last one.

It needs one Supabase secret, `GH_DISPATCH_TOKEN`: a fine-grained GitHub token limited to this repository with **Actions: Read and write**. Set it under Supabase → Edge Functions → Secrets.

Settings needed: **Settings → Pages → Source: GitHub Actions**, and the `WRIKE_TOKEN` secret under **Settings → Secrets and variables → Actions**.

## How sends are tagged

The rule checks need to know whether a send is broad and where it sits in its reminder series. For each send, later sources win:

1. **Auto** — guessed from the Wrike title. Shown on the page as "auto-tagged".
2. **`data/overrides.json`** — hand-checked tags, keyed by the Wrike numeric id (the number in the task's permalink).
3. **Wrike custom fields** — `Broad send` (Yes/No) and `Series step` (Launch, Reminder 1, Reminder 2, Last chance, Single) on the task.

Adding those two custom fields to eBlast tasks in Wrike makes the checks accurate without editing this repo.

## If it stops updating

- Actions tab shows a red run: open it. "WRIKE_TOKEN is not set" or a 401 means the token is missing or expired; create a new one in Wrike (Apps & Integrations → API) and replace the secret.
- GitHub pauses scheduled workflows after 60 days with no repo activity. Click **Enable workflow** on the Actions tab.
