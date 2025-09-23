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

6. Set YouDao appID and key for LaunchBar (\~ ID)

7. Import GPG subkeys

```shell
gpg --import private-subkeys.asc
gpg --edit-key [key-id]
gpg> trust
gpg> save
gpg-connect-agent "keyattr $(gpg --list-keys --with-keygrip | awk '/\[A\]/{f=1;next} f && /Keygrip =/{print $3; exit}') Use-for-ssh: true" /bye
```

## Server

1. Import GPG public key

```shell
gpg --import .config/gnupg/public.asc
```
