try:
    from rich import traceback
    traceback.install(show_locals=True)
except ImportError:
    pass

try:
    import tqdm
    from tqdm import tqdm as original_tqdm

    class CustomTqdm(original_tqdm):
        def __init__(self, *args, **kwargs):
            if 'ncols' not in kwargs:
                kwargs['ncols'] = 120
            super().__init__(*args, **kwargs)

    tqdm.tqdm = CustomTqdm
except ImportError:
    pass
