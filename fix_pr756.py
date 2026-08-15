import os
import re

def rep(filepath, old, new):
    with open(filepath, 'r') as f:
        content = f.read()
    content = content.replace(old, new)
    with open(filepath, 'w') as f:
        f.write(content)

# hrtimers.md
rep('docs/time/hrtimers.md', 'https://lwn.net/Articles/257/', 'https://lwn.net/Articles/732536/') # Note: old URL ID was a placeholder in my head, let's just regex it
