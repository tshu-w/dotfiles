# Dotfiles

``` {.bash org-language="sh"}
git clone --recurse-submodules https://github.com/tshu-w/dotfiles.git
```

## macOS

1. Ensure iCloud Unison folder downloaded

2. Grant terminal Full Disk Access

3. `make`

4. Finish *TODO* and *FIXME* in [macOS.sh](darwin/macOS.sh)

5. Link Documents to Dropbox and lock it

```shell
sudo rm -rf ~/Documents && ln -s ~/Library/CloudStorage/Dropbox/Documents ~
sudo chflags -h uchg ~/Documents
```

6. Set youdao appID and key for Launchbar (\~ ID)

7. Import GPG subkeys

```shell
gpg --import private-subkeys.asc
gpg --edit-key [key-id]
gpg> trust
```

8. Authenticate Github CLI

```shell
gh auth login
gh extension install github/gh-copilot
```

## Server

1. Import GPG public key

```shell
gpg --search-keys mail@address
gpg --export-ssh-key mail@address > ~/.ssh/authorized_keys
gpg --import .config/gnupg/public.asc
```

2. Authenticate Github CLI

```shell
gh auth login
gh extension install github/gh-copilot
```
