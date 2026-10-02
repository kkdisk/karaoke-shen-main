import os
import subprocess
import sys

def build():
    print("--- 開始打包 卡拉OK神 ---")

    # Ensure dependencies are installed
    print("正在檢查/安裝必要依賴 (eel, yt-dlp, requests, bottle, pyinstaller)...")
    base_dir = os.path.dirname(os.path.abspath(__file__))
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-r",
                           os.path.join(base_dir, "requirements.txt")])

    # PyInstaller command
    # --onefile: Bundle into a single executable
    # --noconsole: Don't show terminal window
    # --add-data: Include the 'web' folder
    # --name: Executable name
    # --clean: Clean cache

    # Windows uses ; as separator for add-data, Linux/Mac uses :
    sep = ';' if os.name == 'nt' else ':'

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--noconsole",
        "--collect-all=imageio_ffmpeg",
        "--collect-all=yt_dlp_ejs",
        f"--add-data=web{sep}web",
        f"--add-data=ai_worker.py{sep}.",
        "--name=karaoke-shen",
        "main.py"
    ]

    # Try using an icon if it exists (ideally .ico)
    # Since we only have .svg, we might skip icon for now or just let PyInstaller handle it

    print(f"執行命令: {' '.join(cmd)}")
    try:
        subprocess.run(cmd, check=True, cwd=base_dir)
        runtime_dir = os.path.join(base_dir, '.tools')
        if os.path.isdir(runtime_dir):
            import shutil
            shutil.copytree(runtime_dir, os.path.join(base_dir, 'dist', '.tools'), dirs_exist_ok=True)
        print("\n--- 打包完成！ ---")
        print("您可以在 'dist' 資料夾中找到 'karaoke-shen.exe'")
    except subprocess.CalledProcessError as e:
        print(f"\n打包失敗: {e}")

if __name__ == "__main__":
    build()
