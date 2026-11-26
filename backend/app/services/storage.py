import os
import re
import sqlite3
import struct
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from uuid import uuid4

_MEMORY_SEARCH_STOP_WORDS = frozenset(
    {
        "a", "about", "an", "and", "are", "as", "at", "be", "but", "by",
        "did", "do", "for", "from", "i", "in", "is", "it", "me", "my",
        "of", "on", "or", "that", "the", "this", "to", "was", "what",
        "when", "where", "which", "who", "why", "with", "you", "your",
        "tell",
    }
)
DEFAULT_PERSONALITY = {
    "name": "Digital Me",
    "communication_style": "friendly",
    "response_length": "balanced",
    "custom_instructions": "",
}
DEFAULT_VOICE_SETTINGS = {
    "auto_play_responses": False,
    "continuous_conversation_enabled": False,
}


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
                CREATE TABLE IF NOT EXISTS personality (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    name TEXT NOT NULL DEFAULT 'Digital Me',
                    communication_style TEXT NOT NULL DEFAULT 'friendly',
                    response_length TEXT NOT NULL DEFAULT 'balanced',
                    custom_instructions TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                );
                INSERT OR IGNORE INTO personality (id, updated_at)
                    VALUES (1, '');
                CREATE TABLE IF NOT EXISTS voice_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    auto_play_responses INTEGER NOT NULL DEFAULT 0
                        CHECK (auto_play_responses IN (0, 1)),
                    continuous_conversation_enabled INTEGER NOT NULL DEFAULT 0
                        CHECK (continuous_conversation_enabled IN (0, 1)),
                    updated_at TEXT NOT NULL
                );
                INSERT OR IGNORE INTO voice_settings (id, updated_at)
                    VALUES (1, '');
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
                    embedding BLOB,
                    embedding_model TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS memory_suggestions (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'dismissed')),
                    memory_id TEXT,
                    created_at TEXT NOT NULL,
                    UNIQUE (conversation_id, content COLLATE NOCASE)
                );
                CREATE INDEX IF NOT EXISTS suggestions_by_conversation
                    ON memory_suggestions(conversation_id, status, created_at);
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
            memory_columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(memories)").fetchall()
            }
            if "importance" not in memory_columns:
                connection.execute(
                    "ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 3"
                )
            if "embedding" not in memory_columns:
                connection.execute("ALTER TABLE memories ADD COLUMN embedding BLOB")
            if "embedding_model" not in memory_columns:
                connection.execute("ALTER TABLE memories ADD COLUMN embedding_model TEXT")

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
    def _memory_dict(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "content": row["content"],
            "importance": row["importance"],
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

    def get_personality(self) -> dict[str, str]:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT name, communication_style, response_length,
                       custom_instructions, updated_at
                FROM personality WHERE id = 1
                """
            ).fetchone()
        return dict(row)

    def update_personality(
        self,
        name: str,
        communication_style: str,
        response_length: str,
        custom_instructions: str,
    ) -> dict[str, str]:
        now = self._now()
        with self._connection() as connection:
            connection.execute(
                """
                UPDATE personality
                SET name = ?, communication_style = ?, response_length = ?,
                    custom_instructions = ?, updated_at = ?
                WHERE id = 1
                """,
                (name, communication_style, response_length, custom_instructions, now),
            )
        return self.get_personality()

    def reset_personality(self) -> dict[str, str]:
        return self.update_personality(**DEFAULT_PERSONALITY)

    def get_voice_settings(self) -> dict[str, object]:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT auto_play_responses, continuous_conversation_enabled, updated_at
                FROM voice_settings WHERE id = 1
                """
            ).fetchone()
        return {
            "auto_play_responses": bool(row["auto_play_responses"]),
            "continuous_conversation_enabled": bool(row["continuous_conversation_enabled"]),
            "updated_at": row["updated_at"],
        }

    def update_voice_settings(
        self,
        auto_play_responses: bool,
        continuous_conversation_enabled: bool,
    ) -> dict[str, object]:
        now = self._now()
        with self._connection() as connection:
            connection.execute(
                """
                UPDATE voice_settings
                SET auto_play_responses = ?, continuous_conversation_enabled = ?,
                    updated_at = ?
                WHERE id = 1
                """,
                (int(auto_play_responses), int(continuous_conversation_enabled), now),
            )
        return self.get_voice_settings()

    def create_memory(
        self,
        content: str,
        importance: int = 3,
        embedding: bytes | None = None,
        embedding_model: str | None = None,
    ) -> dict[str, object]:
        memory_id = str(uuid4())
        now = self._now()
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO memories (
                    id, content, importance, embedding, embedding_model,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    memory_id,
                    content,
                    importance,
                    embedding,
                    embedding_model if embedding is not None else None,
                    now,
                    now,
                ),
            )
            row = connection.execute(
                "SELECT * FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
        return self._memory_dict(row)

    def get_memory(self, memory_id: str) -> dict[str, object] | None:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
        return self._memory_dict(row) if row is not None else None

    def list_memories(self, query: str | None = None) -> list[dict[str, object]]:
        if query and query.strip():
            return self.search_memories(query)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM memories ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        return [self._memory_dict(row) for row in rows]

    def search_memories(self, query: str, limit: int = 5) -> list[dict[str, object]]:
        terms = [
            term
            for term in re.findall(r"[\w]{2,}", query, flags=re.UNICODE)
            if term.casefold() not in _MEMORY_SEARCH_STOP_WORDS
        ]
        if not terms:
            return []
        match_expression = " OR ".join(f'"{term}"' for term in dict.fromkeys(terms))
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT memories.*
                FROM memory_search
                JOIN memories ON memories.rowid = memory_search.rowid
                WHERE memory_search MATCH ?
                ORDER BY bm25(memory_search), memories.updated_at DESC
                LIMIT ?
                """,
                (match_expression, limit),
            ).fetchall()
        return [self._memory_dict(row) for row in rows]

    @staticmethod
    def _cosine_similarity(left: bytes, right: bytes) -> float | None:
        if not left or len(left) != len(right) or len(left) % 4:
            return None
        dimensions = len(left) // 4
        left_values = struct.unpack(f"<{dimensions}f", left)
        right_values = struct.unpack(f"<{dimensions}f", right)
        dot_product = sum(a * b for a, b in zip(left_values, right_values))
        left_norm = sum(value * value for value in left_values) ** 0.5
        right_norm = sum(value * value for value in right_values) ** 0.5
        if left_norm == 0 or right_norm == 0:
            return None
        return dot_product / (left_norm * right_norm)

    def search_memories_hybrid(
        self,
        query: str,
        query_embedding: bytes | None,
        embedding_model: str,
        limit: int = 5,
    ) -> list[dict[str, object]]:
        lexical_results = self.search_memories(query, limit=50)
        lexical_ranks = {
            memory["id"]: 1 - index / max(len(lexical_results), 1)
            for index, memory in enumerate(lexical_results)
        }

        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM memories
                WHERE embedding IS NOT NULL AND embedding_model = ?
                """,
                (embedding_model,),
            ).fetchall()

        similarities: dict[str, float] = {}
        for row in rows:
            similarity = (
                self._cosine_similarity(query_embedding, row["embedding"])
                if query_embedding is not None
                else None
            )
            if similarity is not None:
                similarities[row["id"]] = similarity

        semantic_candidates = sorted(
            (
                (memory_id, score)
                for memory_id, score in similarities.items()
                if score >= 0.15
            ),
            key=lambda item: item[1],
            reverse=True,
        )[:50]
        candidate_ids = set(lexical_ranks)
        candidate_ids.update(memory_id for memory_id, _ in semantic_candidates)
        if not candidate_ids:
            return []

        with self._connection() as connection:
            placeholders = ",".join("?" for _ in candidate_ids)
            candidate_rows = connection.execute(
                f"SELECT * FROM memories WHERE id IN ({placeholders})",
                tuple(candidate_ids),
            ).fetchall()

        ranked: list[dict[str, object]] = []
        for row in candidate_rows:
            fts_score = lexical_ranks.get(row["id"], 0.0)
            similarity = similarities.get(row["id"])
            importance_score = row["importance"] / 5
            if query_embedding is not None:
                semantic_score = max(similarity or 0.0, 0.0)
                relevance = (
                    0.65 * semantic_score
                    + 0.25 * fts_score
                    + 0.10 * importance_score
                )
            else:
                relevance = 0.8 * fts_score + 0.2 * importance_score
            ranked.append(
                {
                    **self._memory_dict(row),
                    "similarity": similarity,
                    "relevance": relevance,
                }
            )
        return sorted(
            ranked,
            key=lambda memory: (
                memory["relevance"],
                memory["importance"],
                memory["updated_at"],
            ),
            reverse=True,
        )[:limit]

    def find_similar_memories(
        self,
        content: str,
        embedding: bytes | None,
        embedding_model: str,
        limit: int = 5,
        exclude_id: str | None = None,
    ) -> list[dict[str, object]]:
        normalized_content = " ".join(content.casefold().split())
        with self._connection() as connection:
            rows = connection.execute("SELECT * FROM memories").fetchall()

        similar: list[dict[str, object]] = []
        for row in rows:
            if row["id"] == exclude_id:
                continue
            exact_duplicate = (
                " ".join(row["content"].casefold().split()) == normalized_content
            )
            similarity = (
                self._cosine_similarity(embedding, row["embedding"])
                if embedding is not None
                and row["embedding_model"] == embedding_model
                else None
            )
            if not exact_duplicate and (similarity is None or similarity < 0.72):
                continue
            similar.append(
                {
                    **self._memory_dict(row),
                    "similarity": 1.0 if exact_duplicate else similarity,
                    "kind": "duplicate" if exact_duplicate else "similar",
                }
            )
        return sorted(
            similar,
            key=lambda memory: (
                memory["kind"] == "duplicate",
                memory["similarity"] or 0,
            ),
            reverse=True,
        )[:limit]

    def update_memory(
        self,
        memory_id: str,
        content: str,
        importance: int = 3,
        embedding: bytes | None = None,
        embedding_model: str | None = None,
    ) -> dict[str, object]:
        now = self._now()
        with self._connection() as connection:
            previous = connection.execute(
                "SELECT content, embedding, embedding_model FROM memories WHERE id = ?",
                (memory_id,),
            ).fetchone()
            if previous is None:
                raise RecordNotFoundError("Memory not found.")
            if previous["content"] == content and embedding is None:
                embedding = previous["embedding"]
                embedding_model = previous["embedding_model"]
            cursor = connection.execute(
                """
                UPDATE memories
                SET content = ?, importance = ?, embedding = ?, embedding_model = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    content,
                    importance,
                    embedding,
                    embedding_model if embedding is not None else None,
                    now,
                    memory_id,
                ),
            )
            if cursor.rowcount == 0:
                raise RecordNotFoundError("Memory not found.")
            row = connection.execute(
                "SELECT * FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
        return self._memory_dict(row)

    @staticmethod
    def _suggestion_dict(row: sqlite3.Row) -> dict[str, str]:
        return {
            "id": row["id"],
            "conversation_id": row["conversation_id"],
            "content": row["content"],
            "status": row["status"],
            "created_at": row["created_at"],
        }

    def create_memory_suggestions(
        self,
        conversation_id: str,
        contents: list[str],
    ) -> list[dict[str, str]]:
        now = self._now()
        with self._connection() as connection:
            for content in contents:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO memory_suggestions (
                        id, conversation_id, content, created_at
                    )
                    VALUES (?, ?, ?, ?)
                    """,
                    (str(uuid4()), conversation_id, content, now),
                )
            rows = connection.execute(
                """
                SELECT * FROM memory_suggestions
                WHERE conversation_id = ? AND status = 'pending'
                ORDER BY created_at, id
                """,
                (conversation_id,),
            ).fetchall()
        return [self._suggestion_dict(row) for row in rows]

    def list_memory_suggestions(
        self,
        conversation_id: str,
    ) -> list[dict[str, str]]:
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM memory_suggestions
                WHERE conversation_id = ? AND status = 'pending'
                ORDER BY created_at, id
                """,
                (conversation_id,),
            ).fetchall()
        return [self._suggestion_dict(row) for row in rows]

    def get_memory_suggestion(self, suggestion_id: str) -> dict[str, str] | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT * FROM memory_suggestions
                WHERE id = ? AND status = 'pending'
                """,
                (suggestion_id,),
            ).fetchone()
        return self._suggestion_dict(row) if row is not None else None

    def approve_memory_suggestion(
        self,
        suggestion_id: str,
        importance: int,
        embedding: bytes | None,
        embedding_model: str,
    ) -> dict[str, object] | None:
        now = self._now()
        memory_id = str(uuid4())
        with self._connection() as connection:
            suggestion = connection.execute(
                """
                SELECT * FROM memory_suggestions
                WHERE id = ? AND status = 'pending'
                """,
                (suggestion_id,),
            ).fetchone()
            if suggestion is None:
                return None
            connection.execute(
                """
                INSERT INTO memories (
                    id, content, importance, embedding, embedding_model,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    memory_id,
                    suggestion["content"],
                    importance,
                    embedding,
                    embedding_model if embedding is not None else None,
                    now,
                    now,
                ),
            )
            connection.execute(
                """
                UPDATE memory_suggestions SET status = 'approved', memory_id = ?
                WHERE id = ?
                """,
                (memory_id, suggestion_id),
            )
            row = connection.execute(
                "SELECT * FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
        return self._memory_dict(row)

    def dismiss_memory_suggestion(self, suggestion_id: str) -> bool:
        with self._connection() as connection:
            cursor = connection.execute(
                """
                UPDATE memory_suggestions SET status = 'dismissed'
                WHERE id = ? AND status = 'pending'
                """,
                (suggestion_id,),
            )
        return cursor.rowcount > 0

    def delete_memory(self, memory_id: str) -> bool:
        with self._connection() as connection:
            cursor = connection.execute(
                "DELETE FROM memories WHERE id = ?", (memory_id,)
            )
        return cursor.rowcount > 0
