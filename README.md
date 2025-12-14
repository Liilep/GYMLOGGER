# Gym-logg (FastAPI + statisk frontend)

Backend: FastAPI/SQLModel (`api/`)  
Frontend: statiska filer (`web/`), körs t.ex. via `python -m http.server 3000`  
Auth: JWT Bearer lagras i `localStorage.authToken = "Bearer <token>"`.

## Lokalt (dev)
```bash
python -m venv .venv
.\.venv\Scripts\activate
pip install -r api/requirements.txt
$env:SECRET_KEY="dev-secret-key-change-me"   # byt gärna
uvicorn api.main:app --reload --port 8001

# Ny terminal (frontend)
cd web
python -m http.server 3000
# öppna http://localhost:3000
```
- API-bas autodetekteras mot `http://localhost:8001` via `/health` (ingen manuell config krävs).
- Vill nollställa dev-DB (SQLite): ta bort `data/app.db`. Tabeller skapas automatiskt på startup.

## Produktion

### Render (backend + Postgres)
- `render.yaml` finns i repo. Viktiga miljövariabler:
  - `ENV=prod`
  - `SECRET_KEY` (krävs i prod)
  - `CORS_ORIGINS=https://<din-netlify-app>.netlify.app`
  - `DATABASE_URL` (Render Postgres; kopplas via `fromDatabase` i render.yaml)
- Build: `pip install -r api/requirements.txt`
- Start: `uvicorn api.main:app --host 0.0.0.0 --port $PORT`

### Netlify (frontend)
- `netlify.toml` kör `node scripts/gen-config.js` och publicerar `web/`.
- Sätt env `API_BASE=https://<din-render-app>.onrender.com` i Netlify. Builden failar om den saknas.
- `scripts/gen-config.js` skriver `web/config.js` med `window.API_BASE = "<API_BASE>"`.

### CORS
- Dev: default tillåter `http://localhost:3000` och `http://127.0.0.1:3000`.
- Prod: `CORS_ORIGINS` är obligatorisk (kommaseparerad lista).

### Databas
- Prod: Postgres via `DATABASE_URL` (Render-format `postgres://` normaliseras till `postgresql+psycopg://`).
- Dev: fallback SQLite i `data/app.db`.
- Inga migrations ännu: ändras schemat, droppa/återställ DB (prod: hantera manuellt eller ny databas; dev: ta bort `data/app.db`).

## Hälsa & säkerhet
- Publik hälsokoll: `GET /health` → `{ "ok": true }`.
- JWT-signering: `SECRET_KEY` + `ALGORITHM` (default HS256). `ENV=prod` kräver SECRET_KEY.
- Access-token-tid: `ACCESS_TOKEN_EXPIRE_MINUTES` (default 1440).
- CORS följer `CORS_ORIGINS` (se ovan). Inga stacktraces i prod då `debug=False`.

## Minimalt smoke-test (efter deploy)
1) Registrera via `/auth/register` i UI → få token.  
2) GET `/me` med `Authorization: Bearer <token>` → 200.  
3) GET `/programs` → 200 (tom lista är ok).  
4) GET `/health` → 200 `{ok:true}`.

## Social/publicering (kort)
- Unikt `username` (3–30 tecken, a-z0-9_). FriendRequest/Friendship-tabeller.
- `is_public` på program och PB. Public = synlig för alla inloggade.
- Public endpoints: `GET /users/{username}/programs`, `GET /users/{username}/pbs`.
- Toggla public: `POST /programs/{id}/publish` (resp. `/pbs/{id}/publish`) med body `{ "is_public": true/false }`.

## Datamodell (översikt)
- `Exercise` (name, muscle_group, type, equipment, notes; namn unikt per ägare)
- `Program` (name, description, status, version, is_public)
- `WorkoutTemplate` (program_id, name)
- `TemplateExercise` (exercise_id, planned_sets, reps, planned_weight, rpe, rest, comment)
- `Session` (program_id, template_id, set_logs[], status)
- `SetLog` (exercise_id, set_number, weight, reps, rpe, comment)
- `PersonalBest` (exercise_id, kind, value, reps, date, is_public)
