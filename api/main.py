from datetime import datetime
from typing import List, Optional
import re

from fastapi import FastAPI, Depends, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from sqlmodel import Session, SQLModel, select
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from .db import init_db, get_session
from .models import (
    User,
    Exercise,
    Program,
    WorkoutTemplate,
    TemplateExercise,
    Session as WorkoutSession,
    SetLog,
    PersonalBest,
    Friendship,
    FriendRequest,
)
from .auth import (
    get_current_user,
    authenticate_user,
    get_password_hash,
    create_access_token,
)
from .config import CORS_ORIGINS, DEBUG

app = FastAPI(title="Gym App API", version="0.1", debug=DEBUG)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    init_db()


@app.api_route("/health", methods=["GET", "HEAD"], operation_id="health_check")
@app.api_route("/healthz", methods=["GET", "HEAD"], include_in_schema=False)
def health(session: Session = Depends(get_session)):
    try:
        # Simple DB readiness check; errors bubble as 503.
        session.exec(select(func.count(User.id))).first()
    except Exception:
        raise HTTPException(status_code=503, detail="Database not ready")
    return {"ok": True, "db": "ok"}


@app.get("/")
def index():
    return {"message": "Welcome to Gym App API. See /docs for docs and /health for status."}


class RegisterPayload(SQLModel):
    email: str
    password: str
    display_name: str
    username: str


class ExerciseCreate(SQLModel):
    name: str
    muscle_group: str = ""
    type: str = ""
    equipment: str = ""
    notes: str = ""


class ExerciseUpdate(SQLModel):
    name: Optional[str] = None
    muscle_group: Optional[str] = None
    type: Optional[str] = None
    equipment: Optional[str] = None
    notes: Optional[str] = None


class ProgramCreate(SQLModel):
    name: str
    description: str = ""
    start_date: str = ""
    end_date: str = ""
    status: str = "active"
    version: int = 1
    visibility: str = "private"
    is_public: bool = False


class ProgramUpdate(SQLModel):
    name: Optional[str] = None
    description: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    status: Optional[str] = None
    version: Optional[int] = None
    visibility: Optional[str] = None
    is_public: Optional[bool] = None


class TemplateCreate(SQLModel):
    program_id: int
    name: str


class TemplateUpdate(SQLModel):
    name: Optional[str] = None
    program_id: Optional[int] = None


class TemplateExerciseCreate(SQLModel):
    exercise_id: int
    planned_sets: str = ""
    reps: str = ""
    planned_weight: str = ""
    rpe: str = ""
    rest: str = ""
    comment: str = ""


class TemplateExerciseUpdate(SQLModel):
    exercise_id: Optional[int] = None
    planned_sets: Optional[str] = None
    reps: Optional[str] = None
    planned_weight: Optional[str] = None
    rpe: Optional[str] = None
    rest: Optional[str] = None
    comment: Optional[str] = None


class TemplateExerciseUpdateRequest(TemplateExerciseUpdate):
    row_id: int


class SessionStartPayload(SQLModel):
    template_id: int
    date: Optional[str] = None


class SetLogPayload(SQLModel):
    exercise_id: int
    set_number: int = 1
    weight: float = 0
    reps: int = 0
    rpe: float = 0
    comment: str = ""


class FriendRequestPayload(SQLModel):
    to_username: str


class PublishPayload(SQLModel):
    is_public: bool


# -------- Helpers / validators --------
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,30}$")


def validate_username_or_400(username: str):
    if not USERNAME_RE.match(username or ""):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3-30 chars and contain only letters, numbers or _",
        )


def get_user_by_username(db: Session, username: str) -> Optional[User]:
    return db.exec(select(User).where(User.username == username)).first()


def friendship_key(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def friendship_exists(db: Session, a: int, b: int) -> bool:
    u1, u2 = friendship_key(a, b)
    return (
        db.exec(select(Friendship).where(Friendship.user_id == u1, Friendship.friend_id == u2)).first()
        is not None
    )


def ensure_friendship(db: Session, a: int, b: int):
    u1, u2 = friendship_key(a, b)
    if u1 == u2:
        raise HTTPException(status_code=400, detail="Cannot friend yourself")
    if not friendship_exists(db, u1, u2):
        db.add(Friendship(user_id=u1, friend_id=u2))


# -------- Auth --------
@app.post("/auth/register")
def register(payload: RegisterPayload, session: Session = Depends(get_session)):
    if payload.password is None or len(payload.password) == 0:
        raise HTTPException(status_code=400, detail="Password required")
    if len(payload.password) > 128:
        raise HTTPException(status_code=400, detail="Password too long (max 128 tecken)")
    validate_username_or_400(payload.username)
    existing_email = session.exec(select(User).where(User.email == payload.email)).first()
    if existing_email:
        raise HTTPException(status_code=400, detail="Email already registered")
    existing_username = session.exec(select(User).where(User.username == payload.username)).first()
    if existing_username:
        raise HTTPException(status_code=400, detail="Username already taken")
    user = User(
        email=payload.email,
        username=payload.username,
        password_hash=get_password_hash(payload.password),
        display_name=payload.display_name,
    )
    try:
        session.add(user)
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(status_code=400, detail="User already exists")
    session.refresh(user)
    token = create_access_token({"sub": str(user.id)})
    return {"access_token": token, "token_type": "bearer", "user": user}


@app.post("/auth/login")
def login(
    form_data: OAuth2PasswordRequestForm = Depends(), session: Session = Depends(get_session)
):
    email = form_data.username
    password = form_data.password
    if not email or not password:
        raise HTTPException(status_code=400, detail="Email and password required")
    user = authenticate_user(session, email, password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token({"sub": str(user.id)})
    return {"access_token": token, "token_type": "bearer", "user": user}


@app.get("/me")
def me(user: User = Depends(get_current_user)):
    return user


@app.get("/users/me")
def users_me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "display_name": user.display_name,
        "created_at": user.created_at,
    }


@app.get("/users/by-username/{username}")
def get_user_public_profile(username: str, db: Session = Depends(get_session)):
    target = get_user_by_username(db, username)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    return {"id": target.id, "username": target.username, "display_name": target.display_name}


# -------- Helpers --------
def ensure_owner(obj_owner_id: int, user: User):
    if obj_owner_id != user.id:
        raise HTTPException(status_code=403, detail="Not allowed")


def estimate_one_rm(weight: float, reps: int) -> float:
    return weight * (1 + reps / 30)


def update_personal_bests(db: Session, owner_id: int, session: WorkoutSession, set_log: SetLog):
    est_1rm = estimate_one_rm(set_log.weight, set_log.reps)
    volume = set_log.weight * set_log.reps
    entries = [
        ("est_1rm", "1RM (est)", est_1rm),
        ("max_weight_reps", f"Max weight for {set_log.reps} reps", set_log.weight),
        ("max_volume", "Max volume", volume),
    ]
    for kind, label, value in entries:
        existing = db.exec(
            select(PersonalBest).where(
                PersonalBest.owner_id == owner_id,
                PersonalBest.exercise_id == set_log.exercise_id,
                PersonalBest.kind == kind,
                (PersonalBest.reps == set_log.reps) if kind != "est_1rm" else True,
            )
        ).first()
        if existing:
            if value > existing.value:
                existing.value = value
                existing.reps = set_log.reps
                existing.date = session.date
                existing.set_log_id = set_log.id
                existing.label = label
        else:
            db.add(
                PersonalBest(
                    owner_id=owner_id,
                    exercise_id=set_log.exercise_id,
                    kind=kind,
                    label=label,
                    value=value,
                    reps=set_log.reps,
                    date=session.date,
                    set_log_id=set_log.id,
                )
            )


def serialize_session(db: Session, sess: WorkoutSession):
    data = sess.dict()
    logs = db.exec(select(SetLog).where(SetLog.session_id == sess.id)).all()
    data["set_logs"] = [l.dict() for l in logs]
    return data


# -------- Exercises --------
@app.get("/exercises", response_model=List[Exercise])
def list_exercises(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    return session.exec(select(Exercise).where(Exercise.owner_id == user.id)).all()


@app.post("/exercises", response_model=Exercise)
def create_exercise(
    payload: ExerciseCreate, user: User = Depends(get_current_user), session: Session = Depends(get_session)
):
    name_clean = (payload.name or "").strip()
    if name_clean:
        name_clean = name_clean[0].upper() + name_clean[1:]
    existing = session.exec(
        select(Exercise).where(Exercise.owner_id == user.id).where(func.lower(Exercise.name) == func.lower(name_clean))
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Exercise with this name already exists.")
    ex = Exercise(owner_id=user.id, **payload.dict(exclude={"name"}), name=name_clean)
    session.add(ex)
    session.commit()
    session.refresh(ex)
    return ex


@app.post("/exercises/{exercise_id}", response_model=Exercise)
def update_exercise(
    exercise_id: int,
    payload: ExerciseUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    db_ex = session.get(Exercise, exercise_id)
    if not db_ex:
        raise HTTPException(status_code=404, detail="Exercise not found")
    ensure_owner(db_ex.owner_id, user)
    updates = payload.dict(exclude_unset=True)
    if "name" in updates and updates["name"] is not None:
        name_clean = updates["name"].strip()
        if name_clean:
            name_clean = name_clean[0].upper() + name_clean[1:]
        dup = session.exec(
            select(Exercise)
            .where(Exercise.owner_id == user.id)
            .where(func.lower(Exercise.name) == func.lower(name_clean))
            .where(Exercise.id != exercise_id)
        ).first()
        if dup:
            raise HTTPException(status_code=400, detail="Exercise with this name already exists.")
        updates["name"] = name_clean
    for field, value in updates.items():
        setattr(db_ex, field, value)
    session.add(db_ex)
    session.commit()
    session.refresh(db_ex)
    return db_ex


@app.post("/exercises/delete")
def delete_exercise(
    exercise_id: int = Body(..., embed=True), user: User = Depends(get_current_user), session: Session = Depends(get_session)
):
    db_ex = session.get(Exercise, exercise_id)
    if not db_ex:
        raise HTTPException(status_code=404, detail="Exercise not found")
    ensure_owner(db_ex.owner_id, user)
    session.delete(db_ex)
    session.commit()
    return {"deleted": exercise_id}


@app.post("/exercises/{exercise_id}/delete")
def delete_exercise_by_path(
    exercise_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return delete_exercise(exercise_id=exercise_id, user=user, session=session)


# -------- Programs & templates --------
@app.get("/programs")
def list_programs(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    return session.exec(select(Program).where(Program.owner_id == user.id)).all()


@app.post("/programs")
def create_program(
    payload: ProgramCreate, user: User = Depends(get_current_user), session: Session = Depends(get_session)
):
    program = Program(owner_id=user.id, **payload.dict())
    session.add(program)
    session.commit()
    session.refresh(program)
    return program


@app.post("/programs/{program_id}")
def update_program(
    program_id: int,
    payload: ProgramUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    pr = session.get(Program, program_id)
    if not pr:
        raise HTTPException(status_code=404, detail="Program not found")
    ensure_owner(pr.owner_id, user)
    for field, value in payload.dict(exclude_unset=True).items():
        setattr(pr, field, value)
    session.add(pr)
    session.commit()
    session.refresh(pr)
    return pr


@app.post("/programs/delete")
def delete_program(
    program_id: int = Body(..., embed=True),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    pr = session.get(Program, program_id)
    if not pr:
        raise HTTPException(status_code=404, detail="Program not found")
    ensure_owner(pr.owner_id, user)
    # delete templates & sessions under program
    templates = session.exec(select(WorkoutTemplate).where(WorkoutTemplate.program_id == program_id)).all()
    for tpl in templates:
        rows = session.exec(select(TemplateExercise).where(TemplateExercise.template_id == tpl.id)).all()
        for row in rows:
            session.delete(row)
        session.delete(tpl)
    sessions = session.exec(select(WorkoutSession).where(WorkoutSession.program_id == program_id)).all()
    for s in sessions:
        session.delete(s)
    session.delete(pr)
    session.commit()
    return {"deleted": program_id}


@app.post("/programs/{program_id}/delete")
def delete_program_by_path(
    program_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return delete_program(program_id=program_id, user=user, session=session)


@app.get("/templates")
def list_templates(program_id: Optional[int] = None, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    q = select(WorkoutTemplate).where(WorkoutTemplate.owner_id == user.id)
    if program_id:
        q = q.where(WorkoutTemplate.program_id == program_id)
    templates = session.exec(q).all()
    # hydrate exercises
    result = []
    for tpl in templates:
        rows = session.exec(select(TemplateExercise).where(TemplateExercise.template_id == tpl.id)).all()
        result.append({"template": tpl, "exercises": rows})
    return result


@app.post("/templates")
def create_template(
    payload: TemplateCreate, user: User = Depends(get_current_user), session: Session = Depends(get_session)
):
    tpl = WorkoutTemplate(id=None, owner_id=user.id, **payload.dict())
    session.add(tpl)
    session.commit()
    session.refresh(tpl)
    return tpl


@app.post("/templates/{template_id}")
def update_template(
    template_id: int,
    payload: TemplateUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tpl = session.get(WorkoutTemplate, template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Template not found")
    ensure_owner(tpl.owner_id, user)
    updates = payload.dict(exclude_unset=True)
    for field, value in updates.items():
        setattr(tpl, field, value)
    session.add(tpl)
    session.commit()
    session.refresh(tpl)
    return tpl


@app.post("/templates/{template_id}/add-exercise")
def add_exercise_to_template(
    template_id: int,
    row: TemplateExerciseCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tpl = session.get(WorkoutTemplate, template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Template not found")
    ensure_owner(tpl.owner_id, user)
    row_db = TemplateExercise(id=None, template_id=tpl.id, **row.dict())
    session.add(row_db)
    session.commit()
    session.refresh(row_db)
    return row_db


@app.post("/templates/{template_id}/remove-exercise")
def remove_exercise_from_template(
    template_id: int,
    row_id: int = Body(..., embed=True),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tpl = session.get(WorkoutTemplate, template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Template not found")
    ensure_owner(tpl.owner_id, user)
    row = session.get(TemplateExercise, row_id)
    if not row or row.template_id != tpl.id:
        raise HTTPException(status_code=404, detail="Row not found")
    session.delete(row)
    session.commit()
    return {"deleted": row_id}


@app.post("/templates/{template_id}/update-exercise")
def update_exercise_in_template(
    template_id: int,
    payload: TemplateExerciseUpdateRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tpl = session.get(WorkoutTemplate, template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Template not found")
    ensure_owner(tpl.owner_id, user)
    row = session.get(TemplateExercise, payload.row_id)
    if not row or row.template_id != tpl.id:
        raise HTTPException(status_code=404, detail="Row not found")
    updates = payload.dict(exclude_unset=True)
    updates.pop("row_id", None)
    for field, value in updates.items():
        setattr(row, field, value)
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


@app.post("/templates/delete")
def delete_template(
    template_id: int = Body(..., embed=True),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tpl = session.get(WorkoutTemplate, template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Template not found")
    ensure_owner(tpl.owner_id, user)
    rows = session.exec(select(TemplateExercise).where(TemplateExercise.template_id == template_id)).all()
    for row in rows:
        session.delete(row)
    session.delete(tpl)
    session.commit()
    return {"deleted": template_id}


@app.post("/templates/{template_id}/delete")
def delete_template_by_path(
    template_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return delete_template(template_id=template_id, user=user, session=session)


# -------- Sessions --------
@app.get("/sessions")
def list_sessions(limit: int = 20, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    sessions_db = session.exec(
        select(WorkoutSession).where(WorkoutSession.owner_id == user.id).order_by(WorkoutSession.date.desc())
    ).all()
    sessions_db = sessions_db[:limit]
    return [serialize_session(session, s) for s in sessions_db]


@app.post("/sessions/start")
def start_session(
    payload: SessionStartPayload,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tpl = session.get(WorkoutTemplate, payload.template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Template not found")
    ensure_owner(tpl.owner_id, user)
    program = session.get(Program, tpl.program_id)
    date_value = payload.date or datetime.now().strftime("%Y-%m-%d")
    sess = WorkoutSession(
        owner_id=user.id,
        template_id=tpl.id,
        program_id=tpl.program_id,
        template_name=tpl.name,
        program_name=program.name if program else "",
        date=date_value,
        status="in_progress",
    )
    session.add(sess)
    session.commit()
    session.refresh(sess)
    return serialize_session(session, sess)


@app.post("/sessions/{session_id}/log-set")
def log_set(
    session_id: int,
    log: SetLogPayload,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    sess = db.get(WorkoutSession, session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    ensure_owner(sess.owner_id, user)
    db_log = SetLog(
        session_id=session_id,
        exercise_id=log.exercise_id,
        set_number=log.set_number,
        weight=log.weight,
        reps=log.reps,
        rpe=log.rpe,
        comment=log.comment,
    )
    db.add(db_log)
    db.commit()
    db.refresh(db_log)
    return db_log


@app.post("/sessions/{session_id}/finish")
def finish_session(session_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_session)):
    sess = db.get(WorkoutSession, session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    ensure_owner(sess.owner_id, user)
    sess.status = "done"
    # update PBs
    set_logs = db.exec(select(SetLog).where(SetLog.session_id == sess.id)).all()
    for log in set_logs:
        update_personal_bests(db, user.id, sess, log)
    db.add(sess)
    db.commit()
    db.refresh(sess)
    return serialize_session(db, sess)


@app.post("/sessions/{session_id}/cancel")
def cancel_session(
    session_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_session)
):
    sess = db.get(WorkoutSession, session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    ensure_owner(sess.owner_id, user)
    sess.status = "cancelled"
    logs = db.exec(select(SetLog).where(SetLog.session_id == sess.id)).all()
    for log in logs:
        db.delete(log)
    db.add(sess)
    db.commit()
    db.refresh(sess)
    return serialize_session(db, sess)


@app.post("/sessions/delete")
def delete_session(
    session_id: int = Body(..., embed=True),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    sess = db.get(WorkoutSession, session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    ensure_owner(sess.owner_id, user)
    logs = db.exec(select(SetLog).where(SetLog.session_id == session_id)).all()
    for log in logs:
        db.delete(log)
    db.delete(sess)
    db.commit()
    return {"deleted": session_id}


@app.post("/sessions/clear-active")
def clear_active_sessions(user: User = Depends(get_current_user), db: Session = Depends(get_session)):
    active_sessions = db.exec(
        select(WorkoutSession).where(WorkoutSession.owner_id == user.id, WorkoutSession.status == "in_progress")
    ).all()
    cleared = 0
    for sess in active_sessions:
        logs = db.exec(select(SetLog).where(SetLog.session_id == sess.id)).all()
        for log in logs:
            db.delete(log)
        db.delete(sess)
        cleared += 1
    db.commit()
    return {"cleared": cleared}


# -------- PBs --------
@app.get("/pbs")
def list_pbs(
    exercise_id: Optional[int] = None, reps: Optional[int] = None, user: User = Depends(get_current_user), db: Session = Depends(get_session)
):
    q = select(PersonalBest).where(PersonalBest.owner_id == user.id)
    if exercise_id:
        q = q.where(PersonalBest.exercise_id == exercise_id)
    if reps:
        q = q.where(PersonalBest.reps == reps)
    return db.exec(q).all()


@app.post("/pbs/{pb_id}/publish")
def publish_pb(
    pb_id: int,
    payload: PublishPayload,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    pb = db.get(PersonalBest, pb_id)
    if not pb:
        raise HTTPException(status_code=404, detail="PB not found")
    ensure_owner(pb.owner_id, user)
    pb.is_public = bool(payload.is_public)
    db.add(pb)
    db.commit()
    db.refresh(pb)
    return pb


# -------- Friends --------
@app.post("/friends/requests")
def send_friend_request(
    payload: FriendRequestPayload,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    to_user = get_user_by_username(db, payload.to_username)
    if not to_user:
        raise HTTPException(status_code=404, detail="Recipient not found")
    if to_user.id == user.id:
        raise HTTPException(status_code=400, detail="Cannot send request to yourself")
    if friendship_exists(db, user.id, to_user.id):
        raise HTTPException(status_code=400, detail="You are already friends")
    pending = db.exec(
        select(FriendRequest).where(
            (
                (FriendRequest.from_user_id == user.id) & (FriendRequest.to_user_id == to_user.id)
            )
            | (
                (FriendRequest.from_user_id == to_user.id) & (FriendRequest.to_user_id == user.id)
            ),
            FriendRequest.status == "pending",
        )
    ).first()
    if pending:
        raise HTTPException(status_code=400, detail="Request already pending")
    fr = FriendRequest(from_user_id=user.id, to_user_id=to_user.id, status="pending")
    db.add(fr)
    db.commit()
    db.refresh(fr)
    return {
        "id": fr.id,
        "from_username": user.username,
        "to_username": to_user.username,
        "status": fr.status,
        "created_at": fr.created_at,
    }


@app.get("/friends/requests/incoming")
def list_incoming_requests(user: User = Depends(get_current_user), db: Session = Depends(get_session)):
    reqs = db.exec(
        select(FriendRequest).where(FriendRequest.to_user_id == user.id, FriendRequest.status == "pending")
    ).all()
    result = []
    for fr in reqs:
        from_user = db.get(User, fr.from_user_id)
        result.append(
            {
                "id": fr.id,
                "from_username": from_user.username if from_user else None,
                "from_display_name": from_user.display_name if from_user else None,
                "created_at": fr.created_at,
                "status": fr.status,
            }
        )
    return result


@app.get("/friends/requests/outgoing")
def list_outgoing_requests(user: User = Depends(get_current_user), db: Session = Depends(get_session)):
    reqs = db.exec(
        select(FriendRequest).where(FriendRequest.from_user_id == user.id, FriendRequest.status == "pending")
    ).all()
    result = []
    for fr in reqs:
        to_user = db.get(User, fr.to_user_id)
        result.append(
            {
                "id": fr.id,
                "to_username": to_user.username if to_user else None,
                "to_display_name": to_user.display_name if to_user else None,
                "created_at": fr.created_at,
                "status": fr.status,
            }
        )
    return result


@app.post("/friends/requests/{request_id}/accept")
def accept_friend_request(
    request_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_session)
):
    fr = db.get(FriendRequest, request_id)
    if not fr:
        raise HTTPException(status_code=404, detail="Request not found")
    if fr.to_user_id != user.id:
        raise HTTPException(status_code=403, detail="Not allowed")
    if fr.status != "pending":
        raise HTTPException(status_code=400, detail="Request already handled")
    fr.status = "accepted"
    ensure_friendship(db, fr.from_user_id, fr.to_user_id)
    db.add(fr)
    db.commit()
    db.refresh(fr)
    return fr


@app.post("/friends/requests/{request_id}/reject")
def reject_friend_request(
    request_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_session)
):
    fr = db.get(FriendRequest, request_id)
    if not fr:
        raise HTTPException(status_code=404, detail="Request not found")
    if fr.to_user_id != user.id:
        raise HTTPException(status_code=403, detail="Not allowed")
    if fr.status != "pending":
        raise HTTPException(status_code=400, detail="Request already handled")
    fr.status = "rejected"
    db.add(fr)
    db.commit()
    db.refresh(fr)
    return fr


@app.get("/friends")
def list_friends(user: User = Depends(get_current_user), db: Session = Depends(get_session)):
    links = db.exec(
        select(Friendship).where((Friendship.user_id == user.id) | (Friendship.friend_id == user.id))
    ).all()
    friend_ids = []
    for link in links:
        fid = link.friend_id if link.user_id == user.id else link.user_id
        friend_ids.append(fid)
    if not friend_ids:
        return []
    friends = db.exec(select(User).where(User.id.in_(friend_ids))).all()
    lookup = {u.id: u for u in friends}
    return [
        {"id": fid, "username": lookup.get(fid).username if fid in lookup else None, "display_name": lookup.get(fid).display_name if fid in lookup else None}
        for fid in friend_ids
        if fid in lookup
    ]


# -------- Public content --------
def _get_owner_or_404(db: Session, username: str) -> User:
    user = get_user_by_username(db, username)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@app.get("/users/{username}/programs")
def list_user_programs(
    username: str,
    viewer: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    owner = _get_owner_or_404(db, username)
    is_owner = viewer.id == owner.id
    q = select(Program).where(Program.owner_id == owner.id)
    if not is_owner:
        q = q.where(Program.is_public == True)  # noqa: E712
    return db.exec(q).all()


@app.get("/users/{username}/programs/{program_id}/full")
def get_user_program_full(
    username: str,
    program_id: int,
    viewer: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    owner = _get_owner_or_404(db, username)
    program = db.get(Program, program_id)
    if not program or program.owner_id != owner.id:
        raise HTTPException(status_code=404, detail="Program not found")
    is_owner = viewer.id == owner.id
    if not is_owner and not program.is_public:
        raise HTTPException(status_code=403, detail="Program is not public")
    templates = db.exec(select(WorkoutTemplate).where(WorkoutTemplate.program_id == program.id)).all()
    result_templates = []
    for tpl in templates:
        rows = db.exec(select(TemplateExercise).where(TemplateExercise.template_id == tpl.id)).all()
        exercise_ids = {r.exercise_id for r in rows}
        exercises = []
        if exercise_ids:
            exercises = db.exec(select(Exercise).where(Exercise.id.in_(exercise_ids))).all()
        ex_map = {ex.id: ex for ex in exercises}
        result_templates.append(
            {
                "template": tpl,
                "exercises": [{"row": r, "exercise": ex_map.get(r.exercise_id)} for r in rows],
            }
        )
    return {"program": program, "templates": result_templates}


@app.get("/users/{username}/pbs")
def list_user_public_pbs(
    username: str,
    exercise_id: Optional[int] = None,
    viewer: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    owner = _get_owner_or_404(db, username)
    is_owner = viewer.id == owner.id
    q = select(PersonalBest).where(PersonalBest.owner_id == owner.id)
    if exercise_id:
        q = q.where(PersonalBest.exercise_id == exercise_id)
    if not is_owner:
        q = q.where(PersonalBest.is_public == True)  # noqa: E712
    return db.exec(q).all()


@app.post("/programs/{program_id}/publish")
def publish_program(
    program_id: int,
    payload: PublishPayload,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    program = db.get(Program, program_id)
    if not program:
        raise HTTPException(status_code=404, detail="Program not found")
    ensure_owner(program.owner_id, user)
    program.is_public = bool(payload.is_public)
    db.add(program)
    db.commit()
    db.refresh(program)
    return program


@app.post("/programs/{program_id}/copy")
def copy_program_from_public(
    program_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    source = db.get(Program, program_id)
    if not source:
        raise HTTPException(status_code=404, detail="Program not found")
    if source.owner_id != user.id and not source.is_public:
        raise HTTPException(status_code=403, detail="Program is not public")

    # fetch templates and template exercises
    templates = db.exec(select(WorkoutTemplate).where(WorkoutTemplate.program_id == source.id)).all()
    rows_by_tpl = {}
    exercise_ids = set()
    for tpl in templates:
        rows = db.exec(select(TemplateExercise).where(TemplateExercise.template_id == tpl.id)).all()
        rows_by_tpl[tpl.id] = rows
        for r in rows:
            exercise_ids.add(r.exercise_id)

    exercises = []
    if exercise_ids:
        exercises = db.exec(select(Exercise).where(Exercise.id.in_(exercise_ids))).all()
    ex_map = {ex.id: ex for ex in exercises}

    # copy program
    new_program = Program(
        owner_id=user.id,
        name=f"{source.name} (kopia)" if source.owner_id != user.id else source.name,
        description=source.description,
        start_date=source.start_date,
        end_date=source.end_date,
        status=source.status,
        version=1,
        visibility="private",
        is_public=False,
    )
    db.add(new_program)
    db.commit()
    db.refresh(new_program)

    # copy exercises used in program
    new_ex_map = {}
    for ex in exercises:
        new_ex = Exercise(
          owner_id=user.id,
          name=ex.name,
          muscle_group=ex.muscle_group,
          type=ex.type,
          equipment=ex.equipment,
          notes=ex.notes,
        )
        db.add(new_ex)
        db.commit()
        db.refresh(new_ex)
        new_ex_map[ex.id] = new_ex.id

    # copy templates and their rows
    new_templates = []
    for tpl in templates:
        new_tpl = WorkoutTemplate(program_id=new_program.id, owner_id=user.id, name=tpl.name)
        db.add(new_tpl)
        db.commit()
        db.refresh(new_tpl)
        new_rows = []
        for row in rows_by_tpl.get(tpl.id, []):
            mapped_ex_id = new_ex_map.get(row.exercise_id)
            if not mapped_ex_id:
                continue
            new_row = TemplateExercise(
                template_id=new_tpl.id,
                exercise_id=mapped_ex_id,
                planned_sets=row.planned_sets,
                reps=row.reps,
                planned_weight=row.planned_weight,
                rpe=row.rpe,
                rest=row.rest,
                comment=row.comment,
            )
            db.add(new_row)
            db.commit()
            db.refresh(new_row)
            new_rows.append(new_row)
        new_templates.append({"template": new_tpl, "exercises": new_rows})
    db.commit()

    return {"program": new_program, "templates": new_templates}
