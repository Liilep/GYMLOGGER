from datetime import datetime
from typing import Optional
from sqlmodel import SQLModel, Field
from sqlalchemy import UniqueConstraint


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    email: str = Field(index=True, unique=True)
    username: str = Field(index=True, unique=True)
    password_hash: str
    display_name: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Exercise(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(index=True, foreign_key="user.id")
    name: str
    muscle_group: str = ""
    type: str = ""
    equipment: str = ""
    notes: str = ""


class Program(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(index=True, foreign_key="user.id")
    name: str
    description: str = ""
    start_date: str = ""
    end_date: str = ""
    status: str = "active"
    version: int = 1
    visibility: str = "private"  # private, friends, public
    is_public: bool = False


class WorkoutTemplate(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    program_id: int = Field(index=True, foreign_key="program.id")
    owner_id: int = Field(index=True, foreign_key="user.id")
    name: str


class TemplateExercise(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    template_id: int = Field(index=True, foreign_key="workouttemplate.id")
    exercise_id: int = Field(foreign_key="exercise.id")
    planned_sets: str = ""
    reps: str = ""
    planned_weight: str = ""
    rpe: str = ""
    rest: str = ""
    comment: str = ""


class Session(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(index=True, foreign_key="user.id")
    template_id: int = Field(index=True, foreign_key="workouttemplate.id")
    program_id: int = Field(index=True, foreign_key="program.id")
    template_name: str = ""
    program_name: str = ""
    date: str = ""
    status: str = "in_progress"  # in_progress, done, cancelled


class SetLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: int = Field(index=True, foreign_key="session.id")
    exercise_id: int = Field(foreign_key="exercise.id")
    set_number: int = 1
    weight: float = 0
    reps: int = 0
    rpe: float = 0
    comment: str = ""


class PersonalBest(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(index=True, foreign_key="user.id")
    exercise_id: int = Field(foreign_key="exercise.id")
    kind: str
    label: str
    value: float
    reps: int
    date: str
    set_log_id: int
    is_public: bool = False


class FriendRequest(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    from_user_id: int = Field(index=True, foreign_key="user.id")
    to_user_id: int = Field(index=True, foreign_key="user.id")
    status: str = "pending"  # pending, accepted, rejected
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Friendship(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("user_id", "friend_id"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True, foreign_key="user.id")
    friend_id: int = Field(index=True, foreign_key="user.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
