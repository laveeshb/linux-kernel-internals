import os
import tempfile
from ingest_to_vectorize import chunk_markdown

def test_chunk_markdown():
    # Create a dummy markdown file
    markdown_content = """# Title

This is introductory text.

## First Section

This is the first section.
It spans multiple lines.

### Subsection

Here is a subsection.

## Second Section

The final section.
"""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
        f.write(markdown_content)
        temp_path = f.name
        
    try:
        chunks = chunk_markdown(temp_path)
        
        # Verify chunks
        assert len(chunks) == 4, f"Expected 4 chunks, got {len(chunks)}"
        
        assert chunks[0]['text'] == "# Title\n\nThis is introductory text."
        assert "Introduction" in chunks[0]['source'] or os.path.basename(temp_path) in chunks[0]['source']
        
        assert chunks[1]['text'] == "This is the first section.\nIt spans multiple lines."
        assert "## First Section" in chunks[1]['source']
        
        assert chunks[2]['text'] == "Here is a subsection."
        assert "### Subsection" in chunks[2]['source']
        
        assert chunks[3]['text'] == "The final section."
        assert "## Second Section" in chunks[3]['source']
    finally:
        os.remove(temp_path)
