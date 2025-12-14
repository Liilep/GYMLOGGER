import os
from typing import List

ENV = os.getenv("ENV", "dev").lower()
ALGORITHM = os.getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))

_raw_origins = os.getenv("CORS_ORIGINS", "")
CORS_ORIGINS: List[str] = [o.strip() for o in _raw_origins.split(",") if o.strip()]

if ENV == "prod":
    SECRET_KEY = os.getenv("SECRET_KEY")
    if not SECRET_KEY:
        raise RuntimeError("SECRET_KEY is required when ENV=prod")
    if not CORS_ORIGINS:
        raise RuntimeError("CORS_ORIGINS must be set (comma-separated) when ENV=prod")
else:
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key-change-me")
    if not CORS_ORIGINS:
        CORS_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]

DEBUG = ENV != "prod"
