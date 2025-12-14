import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from datetime import datetime
from urllib.parse import parse_qs, urlparse

from app import (
    DB_FILE,
    ensure_db,
    gen_id,
    load_db,
    save_db,
    update_personal_bests,
)

WEB_DIR = Path("web")


def read_body(request: BaseHTTPRequestHandler) -> dict:
    length = int(request.headers.get("Content-Length", 0))
    if length == 0:
        return {}
    raw = request.rfile.read(length)
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        return {}


def json_response(handler: BaseHTTPRequestHandler, status: int, data: dict) -> None:
    payload = json.dumps(data).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def error(handler: BaseHTTPRequestHandler, status: int, message: str) -> None:
    json_response(handler, status, {"error": message})


def find_item(items, item_id):
    for item in items:
        if item["id"] == item_id:
            return item
    return None


class APIServer(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            self.handle_api_get(parsed)
            return
        self.serve_static(path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            self.handle_api_post(parsed)
            return
        error(self, 404, "Not Found")

    def do_OPTIONS(self) -> None:
        # CORS preflight support
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # ---- Static files ----
    def serve_static(self, path: str) -> None:
        rel_path = path.lstrip("/") or "index.html"
        file_path = WEB_DIR / rel_path
        if not file_path.exists() or not file_path.is_file():
            error(self, 404, "File not found")
            return
        content_type = "text/plain"
        if rel_path.endswith(".html"):
            content_type = "text/html; charset=utf-8"
        elif rel_path.endswith(".css"):
            content_type = "text/css; charset=utf-8"
        elif rel_path.endswith(".js"):
            content_type = "application/javascript; charset=utf-8"
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---- API GET ----
    def handle_api_get(self, parsed) -> None:
        ensure_db()
        db = load_db()
        path = parsed.path
        query = parse_qs(parsed.query)
        segments = [seg for seg in path.split("/") if seg]
        if path == "/api/exercises":
            return json_response(self, 200, {"exercises": db["exercises"]})
        if path == "/api/programs":
            return json_response(self, 200, {"programs": db["programs"]})
        if path == "/api/templates":
            program_id = query.get("program_id", [None])[0]
            templates = db["workout_templates"]
            if program_id:
                templates = [t for t in templates if t["program_id"] == program_id]
            enriched = []
            for tpl in templates:
                program = find_item(db["programs"], tpl["program_id"]) or {}
                tpl_copy = dict(tpl)
                tpl_copy["program_name"] = program.get("name", "")
                rows = []
                for row in tpl["exercises"]:
                    ex = find_item(db["exercises"], row["exercise_id"]) or {}
                    rows.append({**row, "exercise_name": ex.get("name", "Okänd")})
                tpl_copy["exercises"] = rows
                enriched.append(tpl_copy)
            return json_response(self, 200, {"templates": enriched})
        if path == "/api/sessions":
            limit = int(query.get("limit", ["15"])[0])
            sessions = sorted(db["sessions"], key=lambda s: s["date"], reverse=True)
            return json_response(self, 200, {"sessions": sessions[:limit]})
        if path == "/api/pbs":
            exercise_id = query.get("exercise_id", [None])[0]
            pbs = db["personal_bests"]
            if exercise_id:
                pbs = [pb for pb in pbs if pb["exercise_id"] == exercise_id]
            return json_response(self, 200, {"pbs": pbs})
        print(f"[API] Unknown GET {path} segments={segments}")
        error(self, 404, "Unknown endpoint")

    # ---- API POST ----
    def handle_api_post(self, parsed) -> None:
        ensure_db()
        db = load_db()
        path = parsed.path.split("?")[0].rstrip("/")
        segments = [seg for seg in path.split("/") if seg]
        body = read_body(self)
        print(f"[API] {self.command} {path} segments={segments}")
        sys.stdout.flush()

        # Exercises
        if segments[:2] == ["api", "exercises"] and len(segments) == 2:
            required = ["name", "muscle_group", "type"]
            if not all(body.get(r) for r in required):
                return error(self, 400, "Missing fields")
            ex = {
                "id": gen_id(),
                "name": body["name"],
                "muscle_group": body.get("muscle_group", ""),
                "type": body.get("type", ""),
                "equipment": body.get("equipment", ""),
                "notes": body.get("notes", ""),
            }
            db["exercises"].append(ex)
            save_db(db)
            return json_response(self, 201, {"exercise": ex})
        if path == "/api/exercises/delete":
            ex_id = body.get("id")
            if not ex_id:
                return error(self, 400, "Missing id")
            db["exercises"] = [e for e in db["exercises"] if e["id"] != ex_id]
            for tpl in db["workout_templates"]:
                tpl["exercises"] = [r for r in tpl["exercises"] if r["exercise_id"] != ex_id]
            for sess in db["sessions"]:
                sess["set_logs"] = [s for s in sess["set_logs"] if s["exercise_id"] != ex_id]
            save_db(db)
            return json_response(self, 200, {"deleted": ex_id})
        if segments[:2] == ["api", "exercises"] and len(segments) >= 3 and segments[-1] == "update":
            ex_id = segments[2]
            ex = find_item(db["exercises"], ex_id)
            if not ex:
                return error(self, 404, "Exercise not found")
            for key in ["name", "muscle_group", "type", "equipment", "notes"]:
                if key in body and body[key] is not None:
                    ex[key] = body[key]
            save_db(db)
            return json_response(self, 200, {"exercise": ex})

        # Programs
        if segments[:2] == ["api", "programs"] and len(segments) == 2:
            pr = {
                "id": gen_id(),
                "name": body.get("name", "Nytt program"),
                "description": body.get("description", ""),
                "start_date": body.get("start_date", ""),
                "end_date": body.get("end_date", ""),
                "status": body.get("status", "active"),
                "version": body.get("version", 1),
            }
            db["programs"].append(pr)
            save_db(db)
            return json_response(self, 201, {"program": pr})
        if path == "/api/programs/delete":
            pr_id = body.get("id")
            if not pr_id:
                return error(self, 400, "Missing id")
            db["programs"] = [p for p in db["programs"] if p["id"] != pr_id]
            db["workout_templates"] = [t for t in db["workout_templates"] if t["program_id"] != pr_id]
            save_db(db)
            return json_response(self, 200, {"deleted": pr_id})
        if segments[:2] == ["api", "programs"] and len(segments) >= 3 and segments[-1] == "update":
            pr_id = segments[2]
            pr = find_item(db["programs"], pr_id)
            if not pr:
                return error(self, 404, "Program not found")
            for key in ["name", "description", "start_date", "end_date", "status", "version"]:
                if key in body and body[key] is not None:
                    pr[key] = body[key]
            save_db(db)
            return json_response(self, 200, {"program": pr})

        # Templates
        if segments[:2] == ["api", "templates"] and len(segments) == 2:
            program_id = body.get("program_id")
            name = body.get("name")
            if not program_id or not name:
                return error(self, 400, "program_id and name required")
            tpl = {"id": gen_id(), "program_id": program_id, "name": name, "exercises": []}
            db["workout_templates"].append(tpl)
            save_db(db)
            return json_response(self, 201, {"template": tpl})
        if path == "/api/templates/delete":
            tpl_id = body.get("id")
            if not tpl_id:
                return error(self, 400, "Missing id")
            db["workout_templates"] = [t for t in db["workout_templates"] if t["id"] != tpl_id]
            save_db(db)
            return json_response(self, 200, {"deleted": tpl_id})
        if segments[:2] == ["api", "templates"] and len(segments) >= 3 and segments[-1] == "update":
            tpl_id = segments[2]
            tpl = find_item(db["workout_templates"], tpl_id)
            if not tpl:
                return error(self, 404, "Template not found")
            if "name" in body and body["name"] is not None:
                tpl["name"] = body["name"]
            if "program_id" in body and body["program_id"] is not None:
                tpl["program_id"] = body["program_id"]
            save_db(db)
            return json_response(self, 200, {"template": tpl})
        if path.startswith("/api/templates/") and path.endswith("/add-exercise"):
            tpl_id = segments[2] if len(segments) >= 3 else None
            tpl = find_item(db["workout_templates"], tpl_id)
            if not tpl:
                return error(self, 404, "Template not found")
            ex_id = body.get("exercise_id")
            if not ex_id:
                return error(self, 400, "exercise_id required")
            row = {
                "id": gen_id(),
                "exercise_id": ex_id,
                "planned_sets": body.get("planned_sets", ""),
                "reps": body.get("reps", ""),
                "planned_weight": body.get("planned_weight", ""),
                "rpe": body.get("rpe", ""),
                "rest": body.get("rest", ""),
                "comment": body.get("comment", ""),
            }
            tpl["exercises"].append(row)
            save_db(db)
            return json_response(self, 201, {"exercise_row": row})
        if path.startswith("/api/templates/") and path.endswith("/remove-exercise"):
            tpl_id = segments[2] if len(segments) >= 3 else None
            row_id = body.get("row_id")
            tpl = find_item(db["workout_templates"], tpl_id)
            if not tpl:
                return error(self, 404, "Template not found")
            if not row_id:
                return error(self, 400, "row_id required")
            row = None
            for r in tpl["exercises"]:
                if r["id"] == row_id:
                    row = r
                    break
            if not row:
                return error(self, 404, "Template exercise not found")
            tpl["exercises"] = [r for r in tpl["exercises"] if r["id"] != row_id]
            # remove any set logs for this exercise in sessions tied to this template
            for sess in db["sessions"]:
                if sess["template_id"] == tpl_id:
                    sess["set_logs"] = [s for s in sess["set_logs"] if s["exercise_id"] != row.get("exercise_id")]
            save_db(db)
            return json_response(self, 200, {"deleted": row_id})
        if path.startswith("/api/templates/") and path.endswith("/update-exercise"):
            tpl_id = segments[2] if len(segments) >= 3 else None
            row_id = body.get("row_id")
            tpl = find_item(db["workout_templates"], tpl_id)
            if not tpl:
                return error(self, 404, "Template not found")
            if not row_id:
                return error(self, 400, "row_id required")
            row = None
            for r in tpl["exercises"]:
                if r["id"] == row_id:
                    row = r
                    break
            if not row:
                return error(self, 404, "Template exercise not found")
            for key in ["exercise_id", "planned_sets", "reps", "planned_weight", "rpe", "rest", "comment"]:
                if key in body and body[key] is not None:
                    row[key] = body[key]
            save_db(db)
            return json_response(self, 200, {"exercise_row": row})

        # Sessions
        if segments[:3] == ["api", "sessions", "start"]:
            template_id = body.get("template_id")
            tpl = find_item(db["workout_templates"], template_id)
            if not tpl:
                return error(self, 404, "Template not found")
            program = find_item(db["programs"], tpl["program_id"]) or {}
            date_value = body.get("date") or datetime.now().strftime("%Y-%m-%d")
            session = {
                "id": gen_id(),
                "template_id": tpl["id"],
                "program_id": tpl["program_id"],
                "template_name": tpl["name"],
                "program_name": program.get("name", ""),
                "date": date_value,
                "set_logs": [],
                "status": "in_progress",
            }
            db["sessions"].append(session)
            save_db(db)
            return json_response(self, 201, {"session": session})
        if segments[:2] == ["api", "sessions"] and len(segments) >= 3 and segments[-1] == "log-set":
            session_id = segments[2]
            session = find_item(db["sessions"], session_id)
            if not session:
                return error(self, 404, "Session not found")
            log_entry = {
                "id": gen_id(),
                "exercise_id": body.get("exercise_id"),
                "set_number": body.get("set_number", 1),
                "weight": body.get("weight", 0),
                "reps": body.get("reps", 0),
                "rpe": body.get("rpe", 0),
                "comment": body.get("comment", ""),
            }
            session["set_logs"].append(log_entry)
            save_db(db)
            return json_response(self, 201, {"set_log": log_entry})
        if segments[:2] == ["api", "sessions"] and len(segments) >= 3 and segments[-1] == "finish":
            session_id = segments[2]
            session = find_item(db["sessions"], session_id)
            if not session:
                return error(self, 404, "Session not found")
            session["status"] = "done"
            update_personal_bests(db, session)
            save_db(db)
            return json_response(self, 200, {"session": session})
        if path == "/api/sessions/delete":
            session_id = body.get("id")
            if not session_id:
                return error(self, 400, "Missing id")
            db["sessions"] = [s for s in db["sessions"] if s["id"] != session_id]
            save_db(db)
            return json_response(self, 200, {"deleted": session_id})
        if segments[:2] == ["api", "sessions"] and len(segments) >= 3 and segments[-1] == "cancel":
            session_id = segments[2]
            session = find_item(db["sessions"], session_id)
            if not session:
                return error(self, 404, "Session not found")
            session["status"] = "cancelled"
            save_db(db)
            return json_response(self, 200, {"session": session})
        if path == "/api/sessions/clear-active":
            cancelled = 0
            for sess in db["sessions"]:
                if sess["status"] == "in_progress":
                    sess["status"] = "cancelled"
                    cancelled += 1
            save_db(db)
            return json_response(self, 200, {"cancelled": cancelled})

        print(f"[API] Unknown POST {path} segments={segments}")
        error(self, 404, "Unknown endpoint")


def run(port: int = 8000) -> None:
    ensure_db()
    if not WEB_DIR.exists():
        os.makedirs(WEB_DIR, exist_ok=True)
    with ThreadingHTTPServer(("", port), APIServer) as httpd:
        print(f"Server running on http://localhost:{port}")
        print("Stop with Ctrl+C")
        httpd.serve_forever()


if __name__ == "__main__":
    run()
