# Little Wins Goal Tracker

A static HTML/CSS/JavaScript goal tracker hosted on GitHub Pages. Google OAuth grants a user's browser access to the Google Sheets API, and one shared spreadsheet stores goals and progress history.

## Included

- Google authorization from the browser using Google Identity Services
- Shared Google Sheet as the data store
- Create, edit, update progress, and soft-delete goals
- Dark-mode goals dashboard with dated progress entries
- Team competitions with normalized 0–100% progress charts
- Progress bars, active/completed/due-soon counts, search, and filters
- Responsive layout
- No server or database to host

## 1. Create the Google Sheet

Create one spreadsheet and add three tabs with these exact names:

### `Goals`
Put these headers in row 1, in this order:

`id | name | owner_email | description | start_date | end_date | start_value | end_value | unit | status | competition_id | updated_at | favorite | cumulative`

### `Progress History`
Put these headers in row 1, in this order:

`goal_id | date | value | note | updated_by`

### `Competitions`

`id | name | description | start_date | end_date | created_by | created_at`

Competitions define a shared time range. Goals can optionally reference a competition by
`competition_id`. Progress entries are recorded in `Progress History` with their own date;
the app normalizes each goal from its starting value to its ending value and plots each
participant against a straight 0% to 100% target line for the competition.

For goals with `cumulative` set to `true`, each progress entry is treated as an increment
and added to the starting value. Other goals use the latest progress entry as the current
value.

The app can populate empty header rows automatically, but both tabs must already exist. Do not rename or reorder the columns. Goal rows with status `Deleted` are hidden from the app but remain in the sheet.

Copy the spreadsheet ID from its URL:

`https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`

## 2. Configure Google Cloud

1. Open https://console.cloud.google.com/ and create a project.
2. In APIs & Services → Library, enable **Google Sheets API**.
3. Configure Google Auth Platform / OAuth consent:
   - Choose **External** if users aren't all in your Google Workspace organization.
   - Add the app name, support email, and developer contact email.
   - During testing, add each intended user under **Audience → Test users**.
4. Under Google Auth Platform → Clients, create an OAuth client:
   - Application type: **Web application**
   - Authorized JavaScript origins: add your local origin, such as `http://localhost:8000`, and your GitHub Pages origin, such as `https://YOUR_GITHUB_USERNAME.github.io`.
   - Origins do not include a repository path.
5. Copy the OAuth client ID. Do not create or expose a client secret for this static app.

Google setup can change as the Cloud Console evolves. Official guides:
- https://developers.google.com/workspace/sheets/api/quickstart/js
- https://developers.google.com/identity/oauth2/web/guides/overview
- https://developers.google.com/workspace/sheets/api/guides/authorizing

## 3. Configure the app

1. Copy `config.example.js` to `config.js`.
2. Set `googleClientId` to the OAuth client ID from Google Cloud.
3. Set `spreadsheetId` to the shared spreadsheet ID.
4. Keep `goalsSheet` as `Goals`, `historySheet` as `Progress History`, and `competitionsSheet` as `Competitions`, unless you intentionally use different tab names.

Example:

```js
window.GOAL_TRACKER_CONFIG = {
  googleClientId: "123456789-example.apps.googleusercontent.com",
  spreadsheetId: "1AbCdEfExampleSpreadsheetId",
  goalsSheet: "Goals",
  historySheet: "Progress History",
  competitionsSheet: "Competitions"
};
```

`config.js` contains public identifiers, not secrets. It is okay for the file to be delivered to browsers. Never put a service-account key or OAuth client secret in it.

## 4. Run locally

Because the Google OAuth origin must match, run a local web server rather than opening `index.html` as a `file://` URL.

With Python installed, from this folder:

```bash
python -m http.server 8000
```

Open http://localhost:8000. Ensure `http://localhost:8000` is listed as an authorized JavaScript origin in Google Cloud.

## 5. Deploy to GitHub Pages

1. Create a GitHub repository, for example `little-wins`.
2. Add `index.html`, `styles.css`, `app.js`, and your configured `config.js`.
3. In the repository, open **Settings → Pages**.
4. Choose **Deploy from a branch**, select your default branch and `/ (root)`, then save.
5. Wait for GitHub Pages to publish the site.
6. Add the deployed origin, `https://YOUR_GITHUB_USERNAME.github.io`, to the OAuth client's authorized JavaScript origins if it isn't already there. A project site can live at `https://YOUR_GITHUB_USERNAME.github.io/REPOSITORY/`, but the authorized origin is still just `https://YOUR_GITHUB_USERNAME.github.io`.

### Important note about config.js and Git

For the simplest setup, `config.js` can be committed because the OAuth client ID and spreadsheet ID are not secrets. If you prefer not to publish the spreadsheet ID in the repository, keep `config.js` out of version control and add it directly to the deployed files through your own workflow. Hiding the ID is not a substitute for Google permissions.

## 6. Share with users

1. Share the spreadsheet with each person's Google email address as **Viewer** or **Editor**.
2. If the OAuth app is still in Testing mode, add each user under Google Auth Platform → Audience → Test users.
3. Send them the GitHub Pages URL.
4. They click **Connect Google**, choose their account, and approve the requested permissions.

A viewer can read the sheet but write requests should be rejected by Google. The app reports a permission error if a write is denied. The current app doesn't query Drive permissions in advance, so it doesn't guarantee a read-only interface for viewers.

## Important limitations

- This app runs entirely in the browser. It has no private server-side authorization layer.
- Users with Editor access can modify the sheet directly, including rows the app marks as deleted.
- The OAuth token is held in JavaScript memory for the session and is not persisted in local storage.
- On page load, Google Identity Services attempts silent authorization (`prompt: ""`) so returning users normally do not need to approve access again. The access token remains memory-only; if silent authorization is unavailable, click Connect Google.
- The app requests the Sheets read/write scope. Google consent, testing, and verification requirements depend on your OAuth configuration and users.
- The app is designed for a small trusted group, not as a secure multi-tenant application.
- If the Google token expires, click Connect Google again.
- Goal deletion is a soft delete: the row is marked `Deleted` rather than erased.
- The progress history tab records create/edit/progress actions; it is an audit trail, not an immutable log. Editors can change it directly in Sheets.
