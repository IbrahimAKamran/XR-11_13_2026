"""Name FieldAssist's anonymous speakers (S0, S1...) using saved voice profiles."""
import argparse
import sqlite3
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from voice_profiles import PROJECT_DIR, embed_waveform, load_model, load_profiles, match_profile

DEFAULT_DB = PROJECT_DIR.parent / "data" / "fieldassist.sqlite"  # repo root / data
MIN_SECONDS = 2.0   # need this much speech from a speaker before trying
MAX_SECONDS = 15.0  # more than this adds little


def connect(db_path):
    if not db_path.exists():
        raise SystemExit(f"No database at {db_path}. Run FieldAssist first.")
    db = sqlite3.connect(db_path, timeout=10)
    db.row_factory = sqlite3.Row
    return db


def pick_session(db, run_id):
    query = "SELECT run_id, wav_path, sample_rate FROM sessions WHERE wav_path IS NOT NULL "
    if run_id:
        return db.execute(query + "AND run_id = ?", (run_id,)).fetchone()
    return db.execute(query + "ORDER BY started_at DESC LIMIT 1").fetchone()


def speaker_audio(db, session):
    """Return {speaker_label: (samples, sample_rate)} for speakers with enough speech."""
    run_id, wav, sr = session["run_id"], session["wav_path"], session["sample_rate"]
    labels = [r[0] for r in db.execute(
        "SELECT DISTINCT speaker_label FROM utterances WHERE run_id = ? AND speaker_label != 'S?'", (run_id,))]
    clips = {}
    for label in labels:
        spans = db.execute(
            "SELECT t_start, t_end FROM utterances WHERE run_id = ? AND speaker_label = ?", (run_id, label)
        ).fetchall()
        spans.sort(key=lambda s: s["t_end"] - s["t_start"], reverse=True)  # longest first
        pieces, total = [], 0.0
        for s in spans:
            if total >= MAX_SECONDS:
                break
            piece, _ = sf.read(wav, start=int(s["t_start"] * sr), stop=int(s["t_end"] * sr),
                               dtype="float32", always_2d=True)
            if len(piece):
                pieces.append(piece)
                total += len(piece) / sr
        if total >= MIN_SECONDS:
            clips[label] = (np.concatenate(pieces), sr)
    return clips


def ensure_person(db, profile):
    row = db.execute("SELECT id FROM people WHERE display_name = ?", (profile["name"],)).fetchone()
    if row:
        return row["id"]
    cur = db.execute("INSERT INTO people (display_name, created_at, notes) VALUES (?, ?, ?)",
                     (profile["name"], int(time.time() * 1000), profile.get("note")))
    return cur.lastrowid


def label_once(db, model, profiles, session):
    for label, (samples, sr) in speaker_audio(db, session).items():
        voice = embed_waveform(model, samples, sr, source=label)
        score, profile = match_profile(voice, profiles)
        if profile is None:
            print(f"  {label}: no confident match (best score {score:.2f})")
            continue
        person_id = ensure_person(db, profile)
        db.execute(
            """INSERT INTO speaker_assignments (run_id, speaker_label, person_id, confidence, method, created_at)
               VALUES (?, ?, ?, ?, 'ecapa-voiceprint', ?)
               ON CONFLICT(run_id, speaker_label) DO UPDATE SET
                 person_id = excluded.person_id, confidence = excluded.confidence, created_at = excluded.created_at""",
            (session["run_id"], label, person_id, score, int(time.time() * 1000)),
        )
        db.commit()
        print(f"  {label} -> {profile['name']} ({score:.2f})  note: {profile['note']}")


def main():
    parser = argparse.ArgumentParser(description="Label FieldAssist speakers with voice profiles.")
    parser.add_argument("--run", help="run id (default: newest session with audio)")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--watch", action="store_true", help="repeat every 5 s while FieldAssist runs")
    args = parser.parse_args()

    profiles = load_profiles()
    if not profiles:
        raise SystemExit('No profiles yet. Create one: python voice_profiles.py meet --name ... --note ... --consent a.wav b.wav c.wav')
    model = load_model()
    db = connect(args.db)
    while True:
        session = pick_session(db, args.run)
        if session is None:
            print("Waiting for a session with audio...")
        else:
            print(f"-- run {session['run_id']}")
            label_once(db, model, profiles, session)
        if not args.watch:
            break
        time.sleep(5)


if __name__ == "__main__":
    main()