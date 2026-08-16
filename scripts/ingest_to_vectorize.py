import os
import glob
import json
import re
import requests
import uuid

CF_ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID')
CF_API_TOKEN = os.environ.get('CF_API_TOKEN')
INDEX_NAME = "linux-kernel-docs-index"

def get_embedding(text):
    if not CF_ACCOUNT_ID or not CF_API_TOKEN:
        print("Warning: Missing CF_ACCOUNT_ID or CF_API_TOKEN. Skipping real embedding.")
        return [0.0] * 768  # bge-base-en-v1.5 has 768 dimensions
        
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5"
    headers = {"Authorization": f"Bearer {CF_API_TOKEN}"}
    response = requests.post(url, headers=headers, json={"text": [text]})
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

def main():
    docs_dir = os.path.join(os.path.dirname(__file__), '..', 'docs')
    md_files = glob.glob(os.path.join(docs_dir, '**', '*.md'), recursive=True)
    
    vectors = []
    
    for md_file in md_files:
        print(f"Processing {md_file}...")
        chunks = chunk_markdown(md_file)
        
        for chunk in chunks:
            # Skip very small chunks
            if len(chunk['text']) < 50:
                continue
                
            embedding = get_embedding(chunk['text'])
            vector_id = str(uuid.uuid5(uuid.NAMESPACE_URL, chunk['source'] + str(len(chunk['text']))))
            
            vectors.append({
                "id": vector_id,
                "values": embedding,
                "metadata": {
                    "source": chunk['source'],
                    "text": chunk['text'][:1000] # store up to 1000 chars for context
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
