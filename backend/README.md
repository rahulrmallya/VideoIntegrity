# FrameSeal backend

In Windows PowerShell, run these commands from the repository root.

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000
```

Open [FastAPI docs](http://127.0.0.1:8000/docs).

The backend serves the Swagger UI 5.34.1 assets locally for offline use.
