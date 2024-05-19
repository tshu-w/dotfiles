try:
    from rich import traceback
    traceback.install(show_locals=True)
except ImportError:
    pass
