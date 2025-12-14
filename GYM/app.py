import argparse
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

DB_FILE = Path("data/db.json")


def ensure_db() -> None:
    """Create an empty database file if it does not exist."""
    if DB_FILE.exists():
        return
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    empty = {
        "exercises": [],
        "programs": [],
        "workout_templates": [],
        "sessions": [],
        "personal_bests": [],
    }
    DB_FILE.write_text(json.dumps(empty, indent=2))


def load_db() -> Dict[str, Any]:
    ensure_db()
    return json.loads(DB_FILE.read_text())


def save_db(db: Dict[str, Any]) -> None:
    DB_FILE.write_text(json.dumps(db, indent=2))


def gen_id() -> str:
    return uuid.uuid4().hex[:8]


# ---- Exercises -----------------------------------------------------------------
def add_exercise(args: argparse.Namespace) -> None:
    db = load_db()
    exercise = {
        "id": gen_id(),
        "name": args.name,
        "muscle_group": args.muscle_group,
        "type": args.type,
        "equipment": args.equipment,
        "notes": args.notes,
    }
    db["exercises"].append(exercise)
    save_db(db)
    print(f"Added exercise {exercise['name']} (id={exercise['id']})")


def list_exercises(_: argparse.Namespace) -> None:
    db = load_db()
    if not db["exercises"]:
        print("No exercises yet. Add one with: python app.py exercises add --name ...")
        return
    for ex in db["exercises"]:
        print(
            f"{ex['id']}: {ex['name']} | {ex['muscle_group']} | {ex['type']} | equip: {ex['equipment']} | notes: {ex['notes']}"
        )


def require_id(items: List[Dict[str, Any]], item_id: str, label: str) -> Dict[str, Any]:
    for item in items:
        if item["id"] == item_id:
            return item
    raise SystemExit(f"{label} with id '{item_id}' not found")


# ---- Programs and templates -----------------------------------------------------
def add_program(args: argparse.Namespace) -> None:
    db = load_db()
    program = {
        "id": gen_id(),
        "name": args.name,
        "description": args.description,
        "start_date": args.start_date,
        "end_date": args.end_date,
        "status": args.status,
        "version": args.version,
    }
    db["programs"].append(program)
    save_db(db)
    print(f"Added program {program['name']} (id={program['id']})")


def list_programs(_: argparse.Namespace) -> None:
    db = load_db()
    if not db["programs"]:
        print("No programs yet. Add one with: python app.py programs add --name ...")
        return
    for pr in db["programs"]:
        print(
            f"{pr['id']}: {pr['name']} (v{pr['version']}, {pr['status']}) | {pr['description']} | {pr['start_date']} - {pr['end_date']}"
        )


def add_template(args: argparse.Namespace) -> None:
    db = load_db()
    require_id(db["programs"], args.program_id, "Program")
    template = {
        "id": gen_id(),
        "program_id": args.program_id,
        "name": args.name,
        "exercises": [],  # list of WorkoutExerciseTemplate
    }
    db["workout_templates"].append(template)
    save_db(db)
    print(f"Added workout template {template['name']} (id={template['id']})")


def add_template_exercise(args: argparse.Namespace) -> None:
    db = load_db()
    template = require_id(db["workout_templates"], args.template_id, "Template")
    require_id(db["exercises"], args.exercise_id, "Exercise")
    exercise_row = {
        "id": gen_id(),
        "exercise_id": args.exercise_id,
        "planned_sets": args.sets,
        "reps": args.reps,
        "planned_weight": args.weight,
        "rpe": args.rpe,
        "rest": args.rest,
        "comment": args.comment,
    }
    template["exercises"].append(exercise_row)
    save_db(db)
    print(
        f"Added exercise {args.exercise_id} to template {template['name']} (row id={exercise_row['id']})"
    )


def show_template(args: argparse.Namespace) -> None:
    db = load_db()
    template = require_id(db["workout_templates"], args.template_id, "Template")
    program = require_id(db["programs"], template["program_id"], "Program")
    print(f"Template {template['name']} (id={template['id']}) in program {program['name']}")
    if not template["exercises"]:
        print("  No exercises yet.")
        return
    for row in template["exercises"]:
        ex = require_id(db["exercises"], row["exercise_id"], "Exercise")
        print(
            f"  {row['id']}: {ex['name']} | sets {row['planned_sets']} | reps {row['reps']} | weight {row['planned_weight']} | RPE {row['rpe']} | rest {row['rest']} | {row['comment']}"
        )


def copy_program(args: argparse.Namespace) -> None:
    db = load_db()
    program = require_id(db["programs"], args.program_id, "Program")
    new_program = {
        **program,
        "id": gen_id(),
        "name": args.name or f"{program['name']} (copy)",
        "version": args.version,
        "status": "active",
        "start_date": args.start_date,
        "end_date": args.end_date,
    }
    db["programs"].append(new_program)
    # copy templates
    for tpl in db["workout_templates"]:
        if tpl["program_id"] != program["id"]:
            continue
        new_tpl = {
            "id": gen_id(),
            "program_id": new_program["id"],
            "name": tpl["name"],
            "exercises": [dict(row, id=gen_id()) for row in tpl["exercises"]],
        }
        db["workout_templates"].append(new_tpl)
    save_db(db)
    print(
        f"Copied program {program['name']} -> {new_program['name']} (id={new_program['id']}, version {new_program['version']})"
    )


# ---- Sessions and logging -------------------------------------------------------
def start_session(args: argparse.Namespace) -> None:
    db = load_db()
    template = require_id(db["workout_templates"], args.template_id, "Template")
    program = require_id(db["programs"], template["program_id"], "Program")
    session = {
        "id": gen_id(),
        "template_id": template["id"],
        "program_id": program["id"],
        "template_name": template["name"],
        "program_name": program["name"],
        "date": args.date or datetime.now().strftime("%Y-%m-%d"),
        "set_logs": [],
        "status": "in_progress",
    }
    db["sessions"].append(session)
    save_db(db)
    print(f"Started session {session['id']} for {template['name']} on {session['date']}")


def log_set(args: argparse.Namespace) -> None:
    db = load_db()
    session = require_id(db["sessions"], args.session_id, "Session")
    require_id(db["exercises"], args.exercise_id, "Exercise")
    log_entry = {
        "id": gen_id(),
        "exercise_id": args.exercise_id,
        "set_number": args.set_number,
        "weight": args.weight,
        "reps": args.reps,
        "rpe": args.rpe,
        "comment": args.comment,
    }
    session["set_logs"].append(log_entry)
    save_db(db)
    print(f"Logged set {log_entry['id']} in session {session['id']}")


def finish_session(args: argparse.Namespace) -> None:
    db = load_db()
    session = require_id(db["sessions"], args.session_id, "Session")
    if session["status"] == "done":
        print("Session already finished.")
        return
    session["status"] = "done"
    update_personal_bests(db, session)
    save_db(db)
    print(f"Finished session {session['id']} on {session['date']}")


def list_sessions(args: argparse.Namespace) -> None:
    db = load_db()
    sessions = sorted(db["sessions"], key=lambda s: s["date"], reverse=True)
    sessions = sessions[: args.limit]
    if not sessions:
        print("No sessions logged yet.")
        return
    for s in sessions:
        print(
            f"{s['id']}: {s['date']} | {s['template_name']} ({s['program_name']}) | sets: {len(s['set_logs'])} | {s['status']}"
        )


# ---- Personal bests -------------------------------------------------------------
def estimate_one_rm(weight: float, reps: int) -> float:
    return weight * (1 + reps / 30)


def update_personal_bests(db: Dict[str, Any], session: Dict[str, Any]) -> None:
    # Evaluate each set and update PB entries if better than existing.
    date = session["date"]
    for set_log in session["set_logs"]:
        weight = set_log["weight"]
        reps = set_log["reps"]
        est_1rm = estimate_one_rm(weight, reps)
        volume = weight * reps
        exercise_id = set_log["exercise_id"]
        set_id = set_log["id"]
        # est 1RM
        update_pb_entry(
            db=db,
            exercise_id=exercise_id,
            kind="est_1rm",
            label="1RM (est)",
            value=est_1rm,
            reps=reps,
            date=date,
            set_log_id=set_id,
        )
        # max weight for reps
        update_pb_entry(
            db=db,
            exercise_id=exercise_id,
            kind="max_weight_reps",
            label=f"Max weight for {reps} reps",
            value=weight,
            reps=reps,
            date=date,
            set_log_id=set_id,
        )
        # max volume
        update_pb_entry(
            db=db,
            exercise_id=exercise_id,
            kind="max_volume",
            label="Max volume",
            value=volume,
            reps=reps,
            date=date,
            set_log_id=set_id,
        )


def update_pb_entry(
    db: Dict[str, Any],
    exercise_id: str,
    kind: str,
    label: str,
    value: float,
    reps: int,
    date: str,
    set_log_id: str,
) -> None:
    existing: Optional[Dict[str, Any]] = None
    for pb in db["personal_bests"]:
        if pb["exercise_id"] == exercise_id and pb["kind"] == kind and pb["reps"] == reps:
            existing = pb
            break
        if pb["exercise_id"] == exercise_id and pb["kind"] == kind and kind != "max_weight_reps":
            existing = pb
            break
    if existing:
        if value <= existing["value"]:
            return
        existing.update(
            {"value": value, "reps": reps, "date": date, "set_log_id": set_log_id, "label": label}
        )
    else:
        db["personal_bests"].append(
            {
                "id": gen_id(),
                "exercise_id": exercise_id,
                "kind": kind,
                "label": label,
                "value": value,
                "reps": reps,
                "date": date,
                "set_log_id": set_log_id,
            }
        )


def list_pbs(args: argparse.Namespace) -> None:
    db = load_db()
    pbs = db["personal_bests"]
    if args.exercise_id:
        pbs = [pb for pb in pbs if pb["exercise_id"] == args.exercise_id]
    if not pbs:
        print("No PBs yet. Log a session and finish it to compute PBs.")
        return
    for pb in pbs:
        print(
            f"{pb['id']}: ex={pb['exercise_id']} | {pb['label']} | value={pb['value']:.2f} | reps={pb['reps']} | date={pb['date']} | set={pb['set_log_id']}"
        )


# ---- Demo seed ------------------------------------------------------------------
def seed_demo(_: argparse.Namespace) -> None:
    db = load_db()
    if db["exercises"] or db["programs"] or db["workout_templates"]:
        raise SystemExit("Database is not empty. Clear data/db.json if you want to reseed.")

    # exercises
    bench = {
        "id": gen_id(),
        "name": "Bänkpress",
        "muscle_group": "Bröst",
        "type": "styrka",
        "equipment": "skivstång",
        "notes": "",
    }
    squat = {
        "id": gen_id(),
        "name": "Knäböj",
        "muscle_group": "Ben",
        "type": "styrka",
        "equipment": "skivstång",
        "notes": "",
    }
    row = {
        "id": gen_id(),
        "name": "Skivstångsrodd",
        "muscle_group": "Rygg",
        "type": "styrka",
        "equipment": "skivstång",
        "notes": "",
    }
    db["exercises"] = [bench, squat, row]

    # program and template
    program = {
        "id": gen_id(),
        "name": "Enkel 3-dagars",
        "description": "Baslyft med 3 pass/vecka",
        "start_date": datetime.now().strftime("%Y-%m-%d"),
        "end_date": "",
        "status": "active",
        "version": 1,
    }
    db["programs"] = [program]
    template = {
        "id": gen_id(),
        "program_id": program["id"],
        "name": "Måndag – Överkropp",
        "exercises": [
            {
                "id": gen_id(),
                "exercise_id": bench["id"],
                "planned_sets": 4,
                "reps": "6-8",
                "planned_weight": "70kg",
                "rpe": "7-8",
                "rest": "2-3m",
                "comment": "",
            },
            {
                "id": gen_id(),
                "exercise_id": row["id"],
                "planned_sets": 4,
                "reps": "8-10",
                "planned_weight": "60kg",
                "rpe": "7",
                "rest": "2m",
                "comment": "",
            },
        ],
    }
    db["workout_templates"] = [template]
    db["sessions"] = []
    db["personal_bests"] = []
    save_db(db)
    print("Seeded demo data. Try listing exercises and templates.")


def seed_standard_exercises(_: argparse.Namespace) -> None:
    """Add a common set of gym exercises if they are not already present (matched by name)."""
    db = load_db()
    existing_names = {ex["name"].lower() for ex in db["exercises"]}
    standard = [
        ("Bänkpress", "Bröst", "styrka", "skivstång", ""),
        ("Lutande bänkpress", "Bröst", "styrka", "skivstång/hantlar", ""),
        ("Hantelflyes", "Bröst", "styrka", "hantlar", ""),
        ("Knäböj", "Ben", "styrka", "skivstång", ""),
        ("Frontböj", "Ben", "styrka", "skivstång", ""),
        ("Marklyft", "Rygg/Ben", "styrka", "skivstång", ""),
        ("Rumänska marklyft", "Hamstrings", "styrka", "skivstång", ""),
        ("Hip thrust", "Säte", "styrka", "skivstång", ""),
        ("Utfall", "Ben", "styrka", "hantlar/kroppsvikt", ""),
        ("Vadpress", "Vad", "styrka", "maskin/skivstång", ""),
        ("Benpress", "Ben", "styrka", "maskin", ""),
        ("Benspark", "Framsida lår", "styrka", "maskin", ""),
        ("Liggande lårcurl", "Hamstrings", "styrka", "maskin", ""),
        ("Militärpress", "Axlar", "styrka", "skivstång", ""),
        ("Hantelpress axlar", "Axlar", "styrka", "hantlar", ""),
        ("Sida lyft", "Axlar", "styrka", "hantlar", ""),
        ("Face pulls", "Baksida axel", "styrka", "kabel", ""),
        ("Pull-up", "Rygg", "styrka", "kroppsvikt/assist", ""),
        ("Chins", "Rygg/Armar", "styrka", "kroppsvikt/assist", ""),
        ("Latsdrag", "Rygg", "styrka", "maskin", ""),
        ("Skivstångsrodd", "Rygg", "styrka", "skivstång", ""),
        ("Sittande rodd", "Rygg", "styrka", "kabel", ""),
        ("Bicepscurl stång", "Armar", "styrka", "skivstång", ""),
        ("Hantelcurl", "Armar", "styrka", "hantlar", ""),
        ("Triceps pushdown", "Armar", "styrka", "kabel", ""),
        ("Dips", "Bröst/Triceps", "styrka", "kroppsvikt/assist", ""),
        ("Plankan", "Core", "styrka", "kroppsvikt", ""),
        ("Russian twist", "Core", "styrka/kondition", "kettlebell/medicinboll", ""),
        ("Kettlebell swing", "Höft/Condition", "kondition", "kettlebell", ""),
        ("Farmer's walk", "Grepp/Core", "styrka/kondition", "hantlar/kettlebell", ""),
    ]
    added = 0
    for name, mg, typ, equip, notes in standard:
        if name.lower() in existing_names:
            continue
        ex = {
            "id": gen_id(),
            "name": name,
            "muscle_group": mg,
            "type": typ,
            "equipment": equip,
            "notes": notes,
        }
        db["exercises"].append(ex)
        added += 1
    save_db(db)
    print(f"Lade till {added} standardövningar." if added else "Inga nya övningar lades till.")


def seed_standard_programs(_: argparse.Namespace) -> None:
    """Add three standard 3-dagars program (styrka, kondition, hybrid) with passmallar if they don't already exist."""
    db = load_db()

    def find_ex(name: str) -> Optional[str]:
        for ex in db["exercises"]:
            if ex["name"].lower() == name.lower():
                return ex["id"]
        return None

    def program_exists(name: str) -> bool:
        return any(p["name"].lower() == name.lower() for p in db["programs"])

    def add_program_with_templates(name: str, description: str, templates: list[dict]) -> None:
        pr_id = gen_id()
        program = {
            "id": pr_id,
            "name": name,
            "description": description,
            "start_date": "",
            "end_date": "",
            "status": "active",
            "version": 1,
        }
        db["programs"].append(program)
        for tpl_def in templates:
            tpl_id = gen_id()
            rows = []
            for row in tpl_def["rows"]:
                ex_id = find_ex(row["name"])
                if not ex_id:
                    continue
                rows.append(
                    {
                        "id": gen_id(),
                        "exercise_id": ex_id,
                        "planned_sets": row.get("sets", ""),
                        "reps": row.get("reps", ""),
                        "planned_weight": row.get("weight", ""),
                        "rpe": row.get("rpe", ""),
                        "rest": row.get("rest", ""),
                        "comment": row.get("comment", ""),
                    }
                )
            db["workout_templates"].append(
                {
                    "id": tpl_id,
                    "program_id": pr_id,
                    "name": tpl_def["name"],
                    "exercises": rows,
                }
            )

    if program_exists("3-dagars styrka"):
        print("3-dagars styrka finns redan, hoppar över.")
    else:
        add_program_with_templates(
            "3-dagars styrka",
            "Baslyft 3 pass/vecka",
            [
                {
                    "name": "Dag 1: Överkropp",
                    "rows": [
                        {"name": "Bänkpress", "sets": 4, "reps": "6-8", "weight": "70kg", "rest": "2-3m"},
                        {"name": "Militärpress", "sets": 3, "reps": "6-8", "weight": "50kg", "rest": "2m"},
                        {"name": "Skivstångsrodd", "sets": 4, "reps": "8-10", "weight": "60kg", "rest": "2m"},
                    ],
                },
                {
                    "name": "Dag 2: Underkropp",
                    "rows": [
                        {"name": "Knäböj", "sets": 4, "reps": "5-8", "weight": "80kg", "rest": "2-3m"},
                        {"name": "Marklyft", "sets": 3, "reps": "5", "weight": "100kg", "rest": "3m"},
                        {"name": "Vadpress", "sets": 3, "reps": "12-15", "weight": "maskin", "rest": "1-2m"},
                    ],
                },
                {
                    "name": "Dag 3: Armar/Core",
                    "rows": [
                        {"name": "Bicepscurl stång", "sets": 3, "reps": "10-12", "rest": "90s"},
                        {"name": "Triceps pushdown", "sets": 3, "reps": "10-12", "rest": "90s"},
                        {"name": "Plankan", "sets": 3, "reps": "45-60s", "rest": "60s"},
                    ],
                },
            ],
        )
        print("La till program: 3-dagars styrka.")

    if program_exists("3-dagars kondition"):
        print("3-dagars kondition finns redan, hoppar över.")
    else:
        add_program_with_templates(
            "3-dagars kondition",
            "Löp/kondition 3 pass/vecka",
            [
                {
                    "name": "Dag 1: Intervaller",
                    "rows": [
                        {"name": "Kettlebell swing", "sets": 4, "reps": "20", "rest": "90s"},
                        {"name": "Russian twist", "sets": 3, "reps": "20", "rest": "60s"},
                    ],
                },
                {
                    "name": "Dag 2: Flås/grepp",
                    "rows": [
                        {"name": "Farmer's walk", "sets": 4, "reps": "40m", "rest": "90s"},
                        {"name": "Plankan", "sets": 3, "reps": "60s", "rest": "60s"},
                    ],
                },
                {
                    "name": "Dag 3: Blandat",
                    "rows": [
                        {"name": "Kettlebell swing", "sets": 3, "reps": "15", "rest": "90s"},
                        {"name": "Utfall", "sets": 3, "reps": "12/ben", "rest": "90s"},
                    ],
                },
            ],
        )
        print("La till program: 3-dagars kondition.")

    if program_exists("3-dagars hybrid"):
        print("3-dagars hybrid finns redan, hoppar över.")
    else:
        add_program_with_templates(
            "3-dagars hybrid",
            "Kombination styrka/kondition 3 pass/vecka",
            [
                {
                    "name": "Dag 1: Drag + Flås",
                    "rows": [
                        {"name": "Marklyft", "sets": 3, "reps": "5", "rest": "3m"},
                        {"name": "Sittande rodd", "sets": 3, "reps": "10", "rest": "2m"},
                        {"name": "Kettlebell swing", "sets": 3, "reps": "15", "rest": "90s"},
                    ],
                },
                {
                    "name": "Dag 2: Press + Core",
                    "rows": [
                        {"name": "Bänkpress", "sets": 4, "reps": "6-8", "rest": "2-3m"},
                        {"name": "Militärpress", "sets": 3, "reps": "8", "rest": "2m"},
                        {"name": "Plankan", "sets": 3, "reps": "60s", "rest": "60s"},
                    ],
                },
                {
                    "name": "Dag 3: Ben + Gång",
                    "rows": [
                        {"name": "Knäböj", "sets": 3, "reps": "6-8", "rest": "2-3m"},
                        {"name": "Hip thrust", "sets": 3, "reps": "10", "rest": "2m"},
                        {"name": "Farmer's walk", "sets": 3, "reps": "40m", "rest": "90s"},
                    ],
                },
            ],
        )
        print("La till program: 3-dagars hybrid.")

    save_db(db)
    print("Klart.")

# ---- CLI wiring -----------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Träningslogg (filbaserad, CLI).")
    sub = parser.add_subparsers(dest="cmd")

    # exercises
    ex = sub.add_parser("exercises", help="Hantera övningar")
    ex_sub = ex.add_subparsers(dest="ex_cmd")
    ex_add = ex_sub.add_parser("add", help="Lägg till övning")
    ex_add.add_argument("--name", required=True)
    ex_add.add_argument("--muscle-group", required=True)
    ex_add.add_argument("--type", default="styrka")
    ex_add.add_argument("--equipment", default="")
    ex_add.add_argument("--notes", default="")
    ex_add.set_defaults(func=add_exercise)
    ex_list = ex_sub.add_parser("list", help="Lista övningar")
    ex_list.set_defaults(func=list_exercises)

    # programs
    pr = sub.add_parser("programs", help="Program och passmallar")
    pr_sub = pr.add_subparsers(dest="pr_cmd")
    pr_add = pr_sub.add_parser("add", help="Skapa program")
    pr_add.add_argument("--name", required=True)
    pr_add.add_argument("--description", default="")
    pr_add.add_argument("--start-date", dest="start_date", default="")
    pr_add.add_argument("--end-date", dest="end_date", default="")
    pr_add.add_argument("--status", default="active", choices=["active", "archived"])
    pr_add.add_argument("--version", type=int, default=1)
    pr_add.set_defaults(func=add_program)
    pr_list = pr_sub.add_parser("list", help="Lista program")
    pr_list.set_defaults(func=list_programs)
    pr_copy = pr_sub.add_parser("copy", help="Kopiera program till ny version")
    pr_copy.add_argument("--program-id", required=True)
    pr_copy.add_argument("--name")
    pr_copy.add_argument("--version", type=int, default=1)
    pr_copy.add_argument("--start-date", dest="start_date", default="")
    pr_copy.add_argument("--end-date", dest="end_date", default="")
    pr_copy.set_defaults(func=copy_program)

    # templates
    tpl = sub.add_parser("templates", help="Passmallar")
    tpl_sub = tpl.add_subparsers(dest="tpl_cmd")
    tpl_add = tpl_sub.add_parser("add", help="Skapa passmall")
    tpl_add.add_argument("--program-id", required=True)
    tpl_add.add_argument("--name", required=True)
    tpl_add.set_defaults(func=add_template)
    tpl_add_ex = tpl_sub.add_parser("add-exercise", help="Lägg till övning i mall")
    tpl_add_ex.add_argument("--template-id", required=True)
    tpl_add_ex.add_argument("--exercise-id", required=True)
    tpl_add_ex.add_argument("--sets", required=True)
    tpl_add_ex.add_argument("--reps", required=True)
    tpl_add_ex.add_argument("--weight", default="")
    tpl_add_ex.add_argument("--rpe", default="")
    tpl_add_ex.add_argument("--rest", default="")
    tpl_add_ex.add_argument("--comment", default="")
    tpl_add_ex.set_defaults(func=add_template_exercise)
    tpl_show = tpl_sub.add_parser("show", help="Visa mall")
    tpl_show.add_argument("--template-id", required=True)
    tpl_show.set_defaults(func=show_template)

    # sessions
    se = sub.add_parser("sessions", help="Logga pass")
    se_sub = se.add_subparsers(dest="se_cmd")
    se_start = se_sub.add_parser("start", help="Starta pass baserat på mall")
    se_start.add_argument("--template-id", required=True)
    se_start.add_argument("--date", default="")
    se_start.set_defaults(func=start_session)
    se_log = se_sub.add_parser("log-set", help="Logga ett set")
    se_log.add_argument("--session-id", required=True)
    se_log.add_argument("--exercise-id", required=True)
    se_log.add_argument("--set-number", type=int, required=True)
    se_log.add_argument("--weight", type=float, required=True)
    se_log.add_argument("--reps", type=int, required=True)
    se_log.add_argument("--rpe", type=float, default=0.0)
    se_log.add_argument("--comment", default="")
    se_log.set_defaults(func=log_set)
    se_finish = se_sub.add_parser("finish", help="Avsluta pass och beräkna PB")
    se_finish.add_argument("--session-id", required=True)
    se_finish.set_defaults(func=finish_session)
    se_list = se_sub.add_parser("list", help="Visa senaste pass")
    se_list.add_argument("--limit", type=int, default=10)
    se_list.set_defaults(func=list_sessions)

    # personal bests
    pb = sub.add_parser("pbs", help="Personbästa")
    pb_sub = pb.add_subparsers(dest="pb_cmd")
    pb_list = pb_sub.add_parser("list", help="Visa PB")
    pb_list.add_argument("--exercise-id")
    pb_list.set_defaults(func=list_pbs)

    # demo
    demo = sub.add_parser("demo", help="Snabbstart")
    demo_sub = demo.add_subparsers(dest="demo_cmd")
    seed = demo_sub.add_parser("seed", help="Fyll databasen med demoexempel")
    seed.set_defaults(func=seed_demo)
    seed_ex = demo_sub.add_parser("seed-exercises", help="Lägg till standardövningar om de saknas")
    seed_ex.set_defaults(func=seed_standard_exercises)
    seed_prog = demo_sub.add_parser("seed-programs", help="Lägg till tre standardprogram (styrka/kondition/hybrid)")
    seed_prog.set_defaults(func=seed_standard_programs)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if not hasattr(args, "func"):
        parser.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()
