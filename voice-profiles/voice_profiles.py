import argparse
import json
from datetime import datetime, timezone
from pathlib import Path 
from uuid import uuid4

PROJECT_DIR = Path(__file__).resolve().parent
PROFILES_FILE = PROJECT_DIR/"profiles.json"
MODEL_DIR = PROJECT_DIR/"voice_model"

# starting values for voice profile testing 
MIN_SIMILARITY = 0.65
MIN_LEAD = 0.05

def load_profiles():
    if not PROFILES_FILE.exists():
        return []
    return json.loads(PROFILES_FILE.read_text(encoding="utf-8"))

def load_model():
    from speechbrain.inference.speaker import EncoderClassifier
    from speechbrain.utils.fetching import LocalStrategy

    return EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-escpa-voxceleb",
        savedir=str(MODEL_DIR),
        LOCAL_STRATEGY=LocalStrategy.COPY,
        run_opts={"device": "cpu"}
    )

def embed_voice(model, path):
    import soundfile as sf
    import torch
    import torchaudio

    #Soundfile gives one column per channel. Average them into mono
    samples, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    if len(samples) < sample_rate:
        raise ValueError(f"Use a clip with at least one second of audio: {path}")
    waveform = torch.from_numpy(samples.mean(axis=1))
    if sample_rate != 16000:
        waveform = torchaudio.functional.resample(waveform, sample_rate, 16000)
    with torch.inference_mode():
        embedding = model.encode_batch(waveform.unsqueeze(0)).flatten()
    return torch.nn.functional.normalize(embedding, dim=0)

def recognize(args):
    import torch 

    profiles = load_profiles()
    if not profiles:
        print("No profiles found.")
        return

    model = load_model()
    new_voice = embed_voice(model, args.wav)
    ranked = sorted(
        ((torch.dot(new_voice, torch.tensor(profile["embedding"])).item(), profile)
            for profile in profiles),
            key=lambda match: match[0],
            reverse=True,
    )

    best_score, best_profile = ranked[0]
    print(f"Best match on similarity score: {best_score:.3f}")

    close_second = len(ranked) > 1 and best_score - ranked[1][0] < MIN_LEAD
    if best_score < MIN_SIMILARITY or close_second:
        print("No matching profile found.")
        return
    print(f"Possible match: {best_profile['name']}") 
    print(f"Note: {best_profile['note']}")


def meet(args):
    import torch

    profiles = load_profiles()
    model = load_model()
    embeddings = [embed_voice(model, path) for path in args.wavs]
    average = torch.stack(embeddings).mean(dim=0)
    reference = torch.nn.functional.normalize(average, dim=0)

    profiles.append({
        "id": str(uuid4()),
        "name": args.name,
        "note": args.note,
        "consent_recorded_at": datetime.now(timezone.utc).isoformat(),
        "embedding": reference.tolist(),
    })
    PROFILES_FILE.write_text(
        json.dumps(profiles, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Saved profile for {args.name}.")
    
def main():
    parser = argparse.ArgumentParser(description="Save and recognize voice profiles.")
    commands = parser.add_subparsers(dest='command', required=True)

    meet_parser = commands.add_parser("meet", help="Create a profile with permission")
    meet_parser.add_argument("--name", required=True)
    meet_parser.add_argument("--note", required=True)
    meet_parser.add_argument("--consent", action="store_true", required=True)
    meet_parser.add_argument("wavs", nargs=3, type=Path)
    meet_parser.set_defaults(run=meet)

    recognize_parser = commands.add_parser("recognize", help="Match a fresh WAV clip")
    recognize_parser.add_argument("wav", type=Path)
    recognize_parser.set_defaults(run=recognize)

    args = parser.parse_args()
    try:
        args.run(args)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f"Error: {error}\n")


if __name__ == "__main__":
    main()