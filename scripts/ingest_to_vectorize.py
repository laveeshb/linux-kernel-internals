import argparse
import os
import glob
import hashlib
import json
import re
import time
import requests
import uuid
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

CF_ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID')
CF_API_TOKEN = os.environ.get('CF_API_TOKEN')
INDEX_NAME = "linux-kernel-docs-index"

# Workers AI's free plan gives 10,000 neurons/day, SHARED with whatever
# live chat/search traffic the deployed Worker generates that same day —
# see the matching comment in api/src/index.js. bge-base-en-v1.5's
# published rate is ~6,058 neurons per million input tokens; ~4 characters
# per token is a standard rough estimate for English text.
NEURONS_PER_M_TOKENS = 6058
CHARS_PER_TOKEN_ESTIMATE = 4
DAILY_FREE_NEURON_BUDGET = 10000


def estimate_neuron_cost(total_chars):
    tokens = total_chars / CHARS_PER_TOKEN_ESTIMATE
    return (tokens / 1_000_000) * NEURONS_PER_M_TOKENS

_session = requests.Session()
_retry = Retry(
    total=5,
    backoff_factor=1.5,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=["POST"],
)
_session.mount("https://", HTTPAdapter(max_retries=_retry))


def get_embedding(text):
    if not CF_ACCOUNT_ID or not CF_API_TOKEN:
        print("Warning: Missing CF_ACCOUNT_ID or CF_API_TOKEN. Skipping real embedding.")
        return [0.0] * 768  # bge-base-en-v1.5 has 768 dimensions

    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5"
    headers = {"Authorization": f"Bearer {CF_API_TOKEN}"}
    response = _session.post(url, headers=headers, json={"text": [text]}, timeout=30)
    response.raise_for_status()
    return response.json()['result']['data'][0]

def chunk_markdown(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Split by markdown headers (## or ###)
    # This is a simple chunker. For production, a more robust AST parser could be used.
    sections = re.split(r'(^#{2,3}\s+.*$)', content, flags=re.MULTILINE)
    
    chunks = []
    current_title = "Introduction"
    current_text = ""
    
    # sections[0] is everything before the first ##
    if sections[0].strip():
        chunks.append({
            "source": os.path.basename(filepath),
            "text": sections[0].strip()
        })
        
    for i in range(1, len(sections), 2):
        title = sections[i].strip()
        text = sections[i+1].strip() if i+1 < len(sections) else ""
        if text:
            chunks.append({
                "source": f"{os.path.basename(filepath)} - {title}",
                "text": text
            })
            
    return chunks

def collect_chunks(docs_dir):
    md_files = glob.glob(os.path.join(docs_dir, '**', '*.md'), recursive=True)
    all_chunks = []
    for md_file in md_files:
        for chunk in chunk_markdown(md_file):
            if len(chunk['text']) >= 50:  # skip very small chunks
                all_chunks.append(chunk)
    return all_chunks


def main():
    parser = argparse.ArgumentParser(description="Chunk docs/ and embed them for Vectorize.")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Only chunk and estimate cost; make no embedding API calls."
    )
    parser.add_argument(
        "--offset", type=int, default=0,
        help="Skip this many chunks before starting (for splitting a large "
             "corpus across multiple days' free AI budget)."
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Only embed at most this many chunks. Combine with --offset to "
             "process the corpus in batches, e.g. --limit 4000 today, "
             "--offset 4000 tomorrow."
    )
    args = parser.parse_args()

    docs_dir = os.path.join(os.path.dirname(__file__), '..', 'docs')
    all_chunks = collect_chunks(docs_dir)
    chunks = all_chunks[args.offset:]
    if args.limit is not None:
        chunks = chunks[:args.limit]

    if args.offset or args.limit is not None:
        print(f"Batch: chunks[{args.offset}:{args.offset + len(chunks)}] "
              f"of {len(all_chunks)} total.")

    total_chars = sum(len(c['text']) for c in chunks)
    estimated_neurons = estimate_neuron_cost(total_chars)
    pct_of_daily_free = (estimated_neurons / DAILY_FREE_NEURON_BUDGET) * 100

    print(f"Found {len(chunks)} chunks across {len(set(c['source'].split(' - ')[0] for c in chunks))} files.")
    print(f"Estimated embedding cost: ~{estimated_neurons:,.0f} neurons "
          f"(~{pct_of_daily_free:.0f}% of the 10,000/day free allocation).")
    if estimated_neurons > DAILY_FREE_NEURON_BUDGET:
        print(
            "WARNING: this alone exceeds the free daily allocation. On the Workers "
            "Free plan, embedding calls will start failing partway through this run "
            "once the day's budget is spent, and live chat/search traffic on the "
            "site will also be starved for the rest of the day (the budget is "
            "shared). Consider splitting this into multiple days' worth of runs, "
            "or accept a partial run and re-run tomorrow to pick up where it left "
            "off (unembedded/failed chunks are simply skipped from this run's "
            "output, not retried automatically across runs)."
        )
    elif estimated_neurons > DAILY_FREE_NEURON_BUDGET * 0.5:
        print(
            "Note: this will use over half of today's free AI budget — live chat/"
            "search traffic on the site shares the same daily allocation."
        )

    if args.dry_run:
        print("--dry-run: stopping before making any embedding API calls.")
        return

    vectors = []
    for chunk in chunks:
        embedding = get_embedding(chunk['text'])
        # Hash the full chunk text (not just its length) so two different
        # chunks under the same heading can never collide.
        content_hash = hashlib.sha256(chunk['text'].encode('utf-8')).hexdigest()
        vector_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{chunk['source']}:{content_hash}"))

        vectors.append({
            "id": vector_id,
            "values": embedding,
            "metadata": {
                "source": chunk['source'],
                "text": chunk['text'][:1000]  # store up to 1000 chars for context
            }
        })

    # Write to NDJSON for wrangler vectorize insert
    output_file = "vectors.ndjson"
    with open(output_file, 'w') as f:
        for v in vectors:
            f.write(json.dumps(v) + '\n')

    print(f"Generated {len(vectors)} vectors. Saved to {output_file}.")
    print(f"Run: npx wrangler vectorize insert {INDEX_NAME} --file {output_file}")

if __name__ == "__main__":
    main()
