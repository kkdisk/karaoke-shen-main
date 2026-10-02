"""Restricted official-model loader for the isolated Demucs process."""
import hashlib
import re
from fractions import Fraction
from pathlib import Path
from urllib.parse import urlparse


def verified_checkpoint(url, cache, download):
    if not re.fullmatch(r'https://dl\.fbaipublicfiles\.com/demucs/[A-Za-z0-9_./-]+', url):
        raise ValueError('Unsupported model source')
    name = Path(urlparse(url).path).name
    match = re.fullmatch(r'[a-f0-9]+-([a-f0-9]{8,64})\.th', name)
    if not match:
        raise ValueError('Model checksum is missing')
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / name
    if not target.exists():
        temporary = target.with_suffix('.download')
        try:
            download(url, str(temporary), hash_prefix=match[1], progress=True)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    digest = hashlib.sha256()
    with target.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if not digest.hexdigest().startswith(match[1]):
        raise ValueError('Model checksum mismatch; remove the damaged cached model')
    return target


def main():
    import torch
    import numpy as np
    import soundfile
    import torchaudio
    from demucs.htdemucs import HTDemucs
    from demucs.pretrained import _parse_remote_files, REMOTE_ROOT
    from demucs.repo import RemoteRepo
    from demucs.states import load_model
    from demucs.separate import main as separate

    version = tuple(int(n) for n in torch.__version__.split('+')[0].split('.')[:2])
    if version < (2, 10):
        raise RuntimeError('Update the AI environment with setup-ai.ps1 before loading models')
    allowed = set(_parse_remote_files(REMOTE_ROOT / 'files.txt').values())

    def get_model(repository, signature):
        url = repository._models[signature]
        if url not in allowed:
            raise ValueError('Unsupported model source')
        path = verified_checkpoint(url, Path(torch.hub.get_dir()) / 'checkpoints',
                                   torch.hub.download_url_to_file)
        # Official checkpoints contain the model class as well as tensor weights.
        # Allow the architecture and its numeric sample-rate metadata only;
        # never fall back to unrestricted pickle loading.
        with torch.serialization.safe_globals([HTDemucs, Fraction, np.dtype,
                                              np.core.multiarray.scalar, type(np.dtype('float64'))]):
            package = torch.load(path, map_location='cpu', weights_only=True)
        return load_model(package)

    def save_audio(path, tensor, sample_rate, **options):
        # Recent torchaudio.save requires TorchCodec. Demucs emits CPU WAV;
        # SoundFile preserves its requested PCM bit depth without that dependency.
        bits = options.get('bits_per_sample', 16)
        subtype = 'FLOAT' if options.get('encoding') == 'PCM_F' else f'PCM_{bits}'
        soundfile.write(str(path), tensor.detach().cpu().numpy().T, sample_rate, subtype=subtype)

    def load_audio(path):
        data, sample_rate = soundfile.read(str(path), dtype='float32', always_2d=True)
        return torch.from_numpy(data.T.copy()), sample_rate

    RemoteRepo.get_model = get_model
    torchaudio.save = save_audio
    torchaudio.load = load_audio
    separate()


if __name__ == '__main__':
    main()
