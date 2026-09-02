"""Generate launcher_gen.rc from launcher.rc template by substituting version placeholders."""
import sys
import os

def main():
    version = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VERSION", "0.0.0")
    parts = version.split(".")
    csv = ",".join(parts + ["0"] * (4 - len(parts)))

    template_path = os.path.join(os.path.dirname(__file__), "launcher.rc")
    with open(template_path, encoding="utf-8") as f:
        rc = f.read()

    rc = rc.replace("__VERSION_STR__", version)
    rc = rc.replace("__VERSION_FILE_STR__", version + ".0")
    rc = rc.replace("__VERSION_CSV__", csv)

    out_path = "launcher_gen.rc"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(rc)

    print(f"Generated {out_path} for version {version} (CSV: {csv})")

if __name__ == "__main__":
    main()
