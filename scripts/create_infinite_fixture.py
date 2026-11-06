"""Create a synthetic PNG for offline browser acceptance, without provider calls."""
import os
from pathlib import Path
import tempfile
from PIL import Image, ImageDraw

path = Path(__file__).resolve().parents[1] / "data" / "infinite-validation" / "fixture.png"
path.parent.mkdir(parents=True, exist_ok=True)
image = Image.new("RGB", (1024, 1024), "white")
ImageDraw.Draw(image).ellipse((256, 256, 768, 768), fill="green")
with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".png", delete=False) as file:
    temporary = Path(file.name)
try:
    image.save(temporary, "PNG")
    os.replace(temporary, path)
finally:
    temporary.unlink(missing_ok=True)
