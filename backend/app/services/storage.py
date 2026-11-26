import os
import re
import sqlite3
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from uuid import uuid4


class RecordNotFoundError(Exception):
    pass


def get_database_path() -> Path:
    configured_directory = os.environ.get("DIGITAL_ME_DATA_DIR")
    if configured_directory:
        data_directory = Path(configured_directory).expanduser()
    elif sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA")
        data_directory = (
            Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
        ) / "DigitalMe"
    elif sys.platform == "darwin":
        data_directory = Path.home() / "Library" / "Application Support" / "DigitalMe"
    else:
        data_directory = Path(
            os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
        ) / "digital-me"

    return data_directory / "digital-me.sqlite3"


class Database:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or get_database_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        with self._connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS messages_by_conversation
                    ON messages(conversation_id, id);
                CREATE TABLE IF NOT EXISTS profile (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    name TEXT NOT NULL DEFAULT '',
                    about TEXT NOT NULL DEFAULT '',
                    preferences TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                );
                INSERT OR IGNORE INTO profile (id, updated_at)
                    VALUES (1, '');
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(content);
                CREATE TRIGGER IF NOT EXISTS memories_after_insert
                    AFTER INSERT ON memories BEGIN
                        INSERT INTO memory_search (rowid, content)
                        VALUES (new.rowid, new.content);
                    END;
                CREATE TRIGGER IF NOT EXISTS memories_after_update
                    AFTER UPDATE OF content ON memories BEGIN
                        DELETE FROM memory_search WHERE rowid = old.rowid;
                        INSERT INTO memory_search (rowid, content)
                        VALUES (new.rowid, new.content);
                    END;
                CREATE TRIGGER IF NOT EXISTS memories_after_delete
                    AFTER DELETE ON memories BEGIN
                        DELETE FROM memory_search WHERE rowid = old.rowid;
                    END;
                """
            )

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _conversation_dict(row: sqlite3.Row) -> dict[str, str]:
        return {
            "id": row["id"],
            "title": row["title"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _memory_dict(row: sqlite3.Row) -> dict[str, str]:
        return {
            "id": row["id"],
            "content": row["content"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def create_conversation(self) -> dict[str, str]:
        conversation_id = str(uuid4())
        now = self._now()
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO conversations (id, title, created_at, updated_at)
                VALUES (?, 'New conversation', ?, ?)
                """,
                (conversation_id, now, now),
            )
            row = connection.execute(
                "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
        return self._conversation_dict(row)

    def list_conversations(self) -> list[dict[str, str]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM conversations ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        return [self._conversation_dict(row) for row in rows]

    def get_conversation(self, conversation_id: str) -> dict[str, object] | None:
        with self._connection() as connection:
            conversation = connection.execute(
                "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
            if conversation is None:
                return None
            messages = connection.execute(
                """
                SELECT id, role, content, created_at
                FROM messages WHERE conversation_id = ? ORDER BY id
                """,
                (conversation_id,),
            ).fetchall()

        return {
            **self._conversation_dict(conversation),
            "messages": [dict(message) for message in messages],
        }

    def delete_conversation(self, conversation_id: str) -> bool:
        with self._connection() as connection:
            cursor = connection.execute(
                "DELETE FROM conversations WHERE id = ?", (conversation_id,)
            )
        return cursor.rowcount > 0

    def add_message(self, conversation_id: str, role: str, content: str) -> dict[str, object]:
        now = self._now()
        title = " ".join(content.split())[:80]
        with self._connection() as connection:
            conversation = connection.execute(
                "SELECT title FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
            if conversation is None:
                raise RecordNotFoundError("Conversation not found.")
            if role == "user" and conversation["title"] == "New conversation":
                connection.execute(
                    "UPDATE conversations SET title = ? WHERE id = ?",
                    (title or "New conversation", conversation_id),
                )
            cursor = connection.execute(
                """
                INSERT INTO messages (conversation_id, role, content, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (conversation_id, role, content, now),
            )
            connection.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id),
            )
            row = connection.execute(
                "SELECT id, role, content, created_at FROM messages WHERE id = ?",
                (cursor.lastrowid,),
            ).fetchone()
        return dict(row)

    def get_profile(self) -> dict[str, str]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT name, about, preferences, updated_at FROM profile WHERE id = 1"
            ).fetchone()
        return dict(row)

    def update_profile(self, name: str, about: str, preferences: str) -> dict[str, str]:
        now = self._now()
        with self._connection() as connection:
            connection.execute(
                """
                UPDATE profile
                SET name = ?, about = ?, preferences = ?, updated_at = ?
                WHERE id = 1
                """,
                (name, about, preferences, now),
            )
            row = connection.execute(
                "SELECT name, about, preferences, updated_at FROM profile WHERE id = 1"
            ).fetchone()
        return dict(row)

    def create_memory(self, content: str) -> dict[str, str]:
        memory_id = str(uuid4())
        now = self._now()
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO memories (id, content, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (memory_id, content, now, now),
            )
            row = connection.execute(
                "SELECT * FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
        return self._memory_dict(row)

    def list_memories(self, query: str | None = None) -> list[dict[str, str]]:
        if query and query.strip():
            return self.search_memories(query)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM memories ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        return [self._memory_dict(row) for row in rows]

    def search_memories(self, query: str, limit: int = 5) -> list[dict[str, str]]:
        terms = re.findall(r"[\w]{2,}", query, flags=re.UNICODE)
        if not terms:
            return []
        match_expression = " OR ".join(f'"{term}"' for term in dict.fromkeys(terms))
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT memories.*, bm25(memory_search) AS relevance
                FROM memory_search
                JOIN memories ON memories.rowid = memory_search.rowid
                WHERE memory_search MATCH ?
                ORDER BY relevance, memories.updated_at DESC
                LIMIT ?
                """,
                (match_expression, limit),
            ).fetchall()
        return [self._memory_dict(row) for row in rows]

    def update_memory(self, memory_id: str, content: str) -> dict[str, str]:
        now = self._now()
        with self._connection() as connection:
            cursor = connection.execute(
                "UPDATE memories SET content = ?, updated_at = ? WHERE id = ?",
                (content, now, memory_id),
            )
            if cursor.rowcount == 0:
                raise RecordNotFoundError("Memory not found.")
            row = connection.execute(
                "SELECT * FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
        return self._memory_dict(row)

    def delete_memory(self, memory_id: str) -> bool:
        with self._connection() as connection:
            cursor = connection.execute(
                "DELETE FROM memories WHERE id = ?", (memory_id,)
            )
        return cursor.rowcount > 0
