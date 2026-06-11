#!/bin/bash
# Simple PNG placeholder icons using base64 encoded minimal PNGs

# 16x16 icon (purple square with chat bubble)
echo "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA2klEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFAAAJvQCFcFqvxUAAAAASUVORK5CYII=" | base64 -d > icon16.png

# Create simple colored squares for different sizes
convert -size 48x48 xc:#667eea icon48.png 2>/dev/null || echo "#667eea" | convert -size 48x48 xc:#667eea -fill white -gravity center -pointsize 24 -annotate 0 "💬" icon48.png 2>/dev/null || cp icon16.png icon48.png
convert -size 128x128 xc:#667eea icon128.png 2>/dev/null || cp icon16.png icon128.png

echo "Icons generated"
