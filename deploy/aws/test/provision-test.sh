#!/usr/bin/env bash
# deploy/aws/provision.sh against a local AWS emulator (moto, in Docker), never a real
# account (make aws-test). The AWS CLI v2 runs in its pinned image; nothing here needs or
# reads AWS credentials (moto takes fake ones).
#
# The emulated account first gets an unrelated, untagged "wa-bot" world (an instance with its
# own security group and Elastic IP, a bucket, a role) that the script must never touch. Then:
#   - a dry run changes nothing;
#   - without --yes and without a terminal, nothing happens;
#   - a real run creates every resource, tagged and configured as specified;
#   - a second run creates nothing more (same ids) and only re-applies settings;
#   - wa-bot's instance, security group, Elastic IP, bucket and role are unchanged;
#   - slax-* names held by untagged resources make the script stop before any change;
#   - the script contains no terminate/delete/release/revoke/detach call;
#   - the rendered user data is a valid cloud-config (cloud-init's own schema check, in an
#     Ubuntu 24.04 container; SKIP_CLOUD_INIT_SCHEMA=1 skips it).
# JMESPath literals use backquotes inside single quotes, on purpose:
# shellcheck disable=SC2016
set -euo pipefail

moto_image="motoserver/moto:5.2.5@sha256:59a1965d845249b04def37a0e2565f9cc6c44543cb89b68e90f28f344b3b0d1a"
cli_image="amazon/aws-cli:2.39.2@sha256:ed0f6b551cd77b6f34e240488739e4cb90b7534409d404a0c9a2be05c4690ca1"
curl_image="curlimages/curl:8.17.0@sha256:935d9100e9ba842cdb060de42472c7ca90cfe9a7c96e4dacb55e79e560b3ff40"
ubuntu_image="ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"

name="slax-aws-test-$$"
dir="$(mktemp -d)"
cleanup() {
    docker rm -f "$name-moto" >/dev/null 2>&1 || true
    docker network rm "$name" >/dev/null 2>&1 || true
    rm -rf "$dir"
}
trap cleanup EXIT

# A fake key in the Tailscale format (moto never sees a real one).
ts_key="tskey-auth-kTESTnotreal0-0123456789abcdef"
account=123456789012 # moto's
suffix="$(printf 'slax:%s' "$account" | sha256sum | cut -c1-10)"
files="slax-files-$suffix"
backups="slax-backups-$suffix"

env_args=(-e AWS_ENDPOINT_URL="http://$name-moto:5000" -e AWS_ACCESS_KEY_ID=testing -e AWS_SECRET_ACCESS_KEY=testing -e AWS_REGION=eu-central-1)
aws() { docker run --rm --network "$name" "${env_args[@]}" "$cli_image" "$@"; }
# Every AWS CLI call the script makes is logged to $dir/log/calls (a wrapper first in PATH).
mkdir -p "$dir/wrap" "$dir/log"
chmod 777 "$dir/log"
printf '#!/bin/sh\necho "$*" >> /log/calls\nexec /usr/local/bin/aws "$@"\n' > "$dir/wrap/aws"
chmod 755 "$dir/wrap" "$dir/wrap/aws"
# provision [docker options] -- [script arguments]
provision() {
    local options=()
    while [ "$1" != -- ]; do options+=("$1"); shift; done
    shift
    : > "$dir/log/calls"
    docker run --rm --network "$name" "${env_args[@]}" -e SLAX_AMI_PARAMETER=/slax-test/ubuntu-arm64 \
        -e PATH=/wrap:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        -v "$dir/wrap:/wrap:ro" -v "$dir/log:/log" \
        -v "$repo/deploy/aws:/aws:ro" --entrypoint bash "${options[@]}" "$cli_image" /aws/provision.sh "$@"
}
# The calls of the last run that are not read-only (describe/get/list/head/wait, the identity).
writes() { grep -vE '^(--version|sts get-caller-identity|[a-z0-9]+ (describe|get|list|head|wait)[a-z-]*( |$)|ec2 wait )' "$dir/log/calls" || true; }
reset_moto() { docker run --rm --network "$name" "$curl_image" -fsS -X POST "http://$name-moto:5000/moto-api/reset" >/dev/null; }

failures=0
check() { # description, command...
    local description="$1"
    shift
    if "$@"; then echo "ok:   $description"; else echo "FAIL: $description"; failures=$((failures + 1)); fi
}
has() { printf '%s\n' "$1" | grep -qE -- "$2"; }
hasnt() { ! printf '%s\n' "$1" | grep -qE -- "$2"; }
count() { local n; n="$(printf '%s' "$1" | wc -w)"; echo "$n"; }

docker network create "$name" >/dev/null
docker run -d --name "$name-moto" --network "$name" "$moto_image" >/dev/null
for _ in $(seq 1 30); do
    docker run --rm --network "$name" "$curl_image" -fsS -o /dev/null "http://$name-moto:5000/moto-api/" 2>/dev/null && break
    sleep 1
done

# The world before Slax: Canonical's AMI parameter stand-in, and someone else's things.
world() {
    local ami vpc
    ami="$(aws ec2 describe-images --owners amazon --filters Name=architecture,Values=arm64 \
        --query 'sort_by(Images, &Name)[-1].ImageId' --output text)"
    aws ssm put-parameter --name /slax-test/ubuntu-arm64 --type String --value "$ami" --overwrite >/dev/null
    vpc="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
    wa_sg="$(aws ec2 create-security-group --group-name wa-bot-sg --description "another app" --vpc-id "$vpc" \
        --query GroupId --output text)"
    aws ec2 authorize-security-group-ingress --group-id "$wa_sg" --protocol tcp --port 22 --cidr 0.0.0.0/0 >/dev/null
    wa_bot="$(aws ec2 run-instances --image-id "$ami" --instance-type t4g.small --count 1 --security-group-ids "$wa_sg" \
        --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=wa-bot}]' \
        --query 'Instances[0].InstanceId' --output text)"
    wa_eip="$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)"
    aws ec2 associate-address --allocation-id "$wa_eip" --instance-id "$wa_bot" >/dev/null
    aws s3api create-bucket --bucket wa-bot-data --create-bucket-configuration LocationConstraint=eu-central-1 >/dev/null
    aws iam create-role --role-name wa-bot-role --assume-role-policy-document \
        '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
}
# Everything about wa-bot's world that the script could conceivably change, as one string.
wa_snapshot() {
    aws ec2 describe-instances --instance-ids "$wa_bot" --output json --query \
        'Reservations[0].Instances[0].[State.Name, InstanceType, Tags, SecurityGroups, MetadataOptions.[HttpTokens,HttpPutResponseHopLimit], IamInstanceProfile, PublicIpAddress]'
    aws ec2 describe-instance-attribute --instance-id "$wa_bot" --attribute disableApiTermination --output json
    aws ec2 describe-instance-attribute --instance-id "$wa_bot" --attribute userData --output json
    aws ec2 describe-security-groups --group-ids "$wa_sg" --output json --query 'SecurityGroups[0].[IpPermissions,Tags]'
    aws ec2 describe-addresses --allocation-ids "$wa_eip" --output json --query 'Addresses[0].[InstanceId,Tags]'
    aws s3api get-bucket-tagging --bucket wa-bot-data 2>&1 | sed 's/(RequestId[^)]*)//'
    aws s3api get-public-access-block --bucket wa-bot-data 2>&1 | sed 's/(RequestId[^)]*)//'
    aws iam get-role --role-name wa-bot-role --output json --query 'Role.[RoleName,Tags]'
    aws iam list-role-policies --role-name wa-bot-role --output json
}
slax_ids() { # every resource tagged Project=slax, by kind
    echo "instances=$(aws ec2 describe-instances --filters Name=tag:Project,Values=slax Name=instance-state-name,Values=pending,running,stopped \
        --query 'Reservations[].Instances[].InstanceId' --output text)"
    echo "sgs=$(aws ec2 describe-security-groups --filters Name=tag:Project,Values=slax --query 'SecurityGroups[].GroupId' --output text)"
    echo "eips=$(aws ec2 describe-addresses --filters Name=tag:Project,Values=slax --query 'Addresses[].AllocationId' --output text)"
    echo "buckets=$(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'slax-')].Name" --output text)"
    echo "roles=$(aws iam list-roles --query "Roles[?starts_with(RoleName, 'slax-')].RoleName" --output text)"
}

echo "== static"
code="$(grep -v '^[[:space:]]*#' "$repo/deploy/aws/provision.sh")"
check "provision.sh has no terminate/delete/release/revoke/detach/disassociate call" \
    hasnt "$code" '(terminate|delete|release|revoke|detach|disassociate|deregister|remove)-[a-z]'

echo "== an account with someone else's things"
world
before="$(wa_snapshot)"

out="$(provision -- --dry-run 2>&1)" && status=0 || status=$?
check "dry run succeeds" test "$status" = 0
check "... prints the plan" has "$out" "EC2 instance +slax-prod +t4g.small, 30 GB gp3 encrypted.*\\[create\\]"
check "... and the monthly cost before anything" has "$out" '^This will cost about \$[0-9]+\.[0-9]{2}/month'
check "... says nothing changed" has "$out" '^Dry run: nothing was changed\.$'
check "... made read-only AWS calls only" test -z "$(writes)"
check "... (and some: the log works)" test "$(wc -l < "$dir/log/calls")" -gt 10
check "... and nothing did" test "$(slax_ids | tr '\n' ' ')" = "instances= sgs= eips= buckets= roles= "

out="$(provision -- 2>&1 < /dev/null)" && status=0 || status=$?
check "without --yes and without a terminal, it refuses" test "$status" != 0
check "... before any change" test "$(slax_ids | tr '\n' ' ')" = "instances= sgs= eips= buckets= roles= "

out="$(provision -i -- --yes 2>&1)" && status=0 || status=$?
check "--yes without TS_AUTHKEY refuses to create the instance" test "$status" != 0
check "... before any change" test "$(slax_ids | tr '\n' ' ')" = "instances= sgs= eips= buckets= roles= "

echo "== first run"
out="$(provision -e TS_AUTHKEY="$ts_key" -- --yes 2>&1)" && status=0 || status=$?
check "provision.sh --yes succeeds" test "$status" = 0 || printf '%s\n' "$out" | tail -20
check "... never prints the Tailscale key" hasnt "$out" "$ts_key"
check "... prints the DNS record (A slax.yechpa.com -> the Elastic IP)" has "$out" 'A  slax\.yechpa\.com  ->  [0-9.]+'
check "... says no files.slax.yechpa.com record is needed" has "$out" 'No record for files\.slax\.yechpa\.com'
check "... prints both Google redirect URIs" has "$(printf '%s\n' "$out" | grep -c 'auth/google/callback')" '^2$'
first="$(slax_ids)"
instance="$(printf '%s\n' "$first" | sed -n 's/^instances=//p')"
sg="$(printf '%s\n' "$first" | sed -n 's/^sgs=//p')"
eip="$(printf '%s\n' "$first" | sed -n 's/^eips=//p')"
check "one instance, one security group, one Elastic IP" test "$(count "$instance")$(count "$sg")$(count "$eip")" = 111
bucket_role="$(printf '%s\n' "$first" | sed -n 's/^buckets=//p;s/^roles=//p' | tr -s '[:space:]' '\n' | sort | tr '\n' ' ')"
check "the two buckets and the role" test "$bucket_role" = "$backups $files slax-prod-instance "

inst="$(aws ec2 describe-instances --instance-ids "$instance" --output text --query \
    'Reservations[0].Instances[0].[InstanceType, MetadataOptions.HttpTokens, MetadataOptions.HttpPutResponseHopLimit, Monitoring.State, IamInstanceProfile.Arn, length(SecurityGroups), SecurityGroups[0].GroupName, KeyName]')"
check "instance: t4g.small, IMDSv2 only, hop limit 2, no detailed monitoring, instance profile, only slax-prod SG, no key pair" \
    has "$inst" "^t4g\\.small\\s+required\\s+2\\s+disabled\\s+arn:aws:iam::$account:instance-profile/slax-prod-instance\\s+1\\s+slax-prod\\s+None$"
check "instance: termination protection on" test "$(aws ec2 describe-instance-attribute --instance-id "$instance" --attribute disableApiTermination --query DisableApiTermination.Value --output text)" = True
check "instance: tagged Project=slax, Name=slax-prod" test "$(aws ec2 describe-instances --instance-ids "$instance" --output text --query "Reservations[0].Instances[0].Tags[?Key=='Project' || Key=='Name'] | sort_by(@, &Key)[].Value | join(',', @)")" = "slax-prod,slax"
vol="$(aws ec2 describe-volumes --filters "Name=attachment.instance-id,Values=$instance" --output text --query 'Volumes[0].[VolumeType, Size, Encrypted, Tags[?Key==`Project`].Value | [0]]')"
check "root volume: gp3, 30 GB, encrypted, tagged" has "$vol" '^gp3\s+30\s+True\s+slax$'
aws ec2 describe-instance-attribute --instance-id "$instance" --attribute userData --query UserData.Value --output text | base64 -d > "$dir/user-data"
check "user data: cloud-config with the key and the Caddyfile filled in, no placeholder left" \
    sh -c "head -1 '$dir/user-data' | grep -qx '#cloud-config' && grep -qF '$ts_key' '$dir/user-data' && ! grep -q '__SLAX_' '$dir/user-data'"
caddy_b64="$(base64 -w0 < "$repo/deploy/aws/Caddyfile")"
check "user data: the Caddyfile is the repository's" grep -qF "$caddy_b64" "$dir/user-data"

rules="$(aws ec2 describe-security-groups --group-ids "$sg" --output text --query \
    'SecurityGroups[0].IpPermissions[].[IpProtocol, FromPort, ToPort, join(`,`, IpRanges[].CidrIp), join(`,`, Ipv6Ranges[].CidrIpv6)]' | sort)"
check "security group: inbound TCP 80 and 443 from anywhere, nothing else" \
    test "$(printf '%s' "$rules" | tr -s '\t\n' '  ')" = "tcp 443 443 0.0.0.0/0 ::/0 tcp 80 80 0.0.0.0/0 ::/0"
check "Elastic IP: tagged and on the instance" test "$(aws ec2 describe-addresses --allocation-ids "$eip" --output text --query 'Addresses[0].[InstanceId, Tags[?Key==`Project`].Value | [0]]' | tr '\t' ' ')" = "$instance slax"

policy="$(aws iam get-role-policy --role-name slax-prod-instance --policy-name slax-prod-s3 --output json --query PolicyDocument)"
check "role policy: only the two buckets" test "$(printf '%s' "$policy" | grep -oE 'arn:aws:s3:::[a-z0-9-]+' | sort -u | tr '\n' ' ')" = "arn:aws:s3:::$backups arn:aws:s3:::$files "
check "role policy: no delete on backups, no wildcard action" sh -c "! printf '%s' '$policy' | tr -d ' \n' | grep -qE 'BackupsObjectsNoDelete[^}]*DeleteObject|\"s3:\\*\"|\"\\*\"'"
check "role and instance profile: tagged, profile holds the role" \
    test "$(aws iam get-instance-profile --instance-profile-name slax-prod-instance --output text --query 'InstanceProfile.[Roles[0].RoleName, Tags[?Key==`Project`].Value | [0]]' | tr '\t' ' ')" = "slax-prod-instance slax"

for bucket in "$files" "$backups"; do
    check "$bucket: tagged Project=slax" test "$(aws s3api get-bucket-tagging --bucket "$bucket" --output text --query 'TagSet[?Key==`Project`].Value | [0]')" = slax
    check "$bucket: Block Public Access, all four" test "$(aws s3api get-public-access-block --bucket "$bucket" --output text --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' | tr '\t' ' ')" = "True True True True"
    check "$bucket: SSE-S3 by default" test "$(aws s3api get-bucket-encryption --bucket "$bucket" --output text --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm')" = AES256
    check "$bucket: TLS only" has "$(aws s3api get-bucket-policy --bucket "$bucket" --output text --query Policy)" '"aws:SecureTransport": ?"false"'
    check "$bucket: incomplete multipart uploads aborted after 1 day" has "$(aws s3api get-bucket-lifecycle-configuration --bucket "$bucket" --output json)" '"DaysAfterInitiation": 1'
done
check "$backups: versioned" test "$(aws s3api get-bucket-versioning --bucket "$backups" --query Status --output text)" = Enabled
check "$backups: dumps expire after 35 days" has "$(aws s3api get-bucket-lifecycle-configuration --bucket "$backups" --output json | tr -d ' \n')" '"Expiration":\{"Days":35\}'
check "$files: not versioned" test "$(aws s3api get-bucket-versioning --bucket "$files" --query Status --output text)" = None

check "wa-bot's instance, security group, Elastic IP, bucket and role are unchanged" test "$(wa_snapshot)" = "$before"

echo "== second run"
out="$(provision -e TS_AUTHKEY="$ts_key" -- --yes 2>&1)" && status=0 || status=$?
check "provision.sh --yes succeeds again" test "$status" = 0
check "... creates nothing" hasnt "$out" '\+ aws (ec2 run-instances|ec2 allocate-address|ec2 create-security-group|ec2 associate-address|ec2 authorize|iam create-|s3api create-bucket)'
check "... the same resources" test "$(slax_ids)" = "$first"
check "... wa-bot is still unchanged" test "$(wa_snapshot)" = "$before"
out="$(provision -- --dry-run 2>&1)"
check "a dry run now reports everything as existing" test "$(printf '%s\n' "$out" | grep -c '\[exists: ')" = 7
check "... with read-only AWS calls only" test -z "$(writes)"

echo "== refusals: slax-* names on resources without the tag"
reset_moto
world
vpc="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
aws ec2 create-security-group --group-name slax-prod --description impostor --vpc-id "$vpc" >/dev/null
out="$(provision -e TS_AUTHKEY="$ts_key" -- --yes 2>&1)" && status=0 || status=$?
check "an untagged security group named slax-prod: refused" sh -c "test $status != 0 && printf '%s' \"\$1\" | grep -q 'security group slax-prod .* WITHOUT tag Project=slax'" _ "$out"
check "... before any change" test "$(slax_ids | tr '\n' ' ')" = "instances= sgs= eips= buckets= roles= "
check "... not a single write call" test -z "$(writes)"

reset_moto
world
aws ec2 run-instances --image-id "$(aws ssm get-parameter --name /slax-test/ubuntu-arm64 --query Parameter.Value --output text)" \
    --instance-type t4g.small --count 1 --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=slax-prod}]' >/dev/null
out="$(provision -e TS_AUTHKEY="$ts_key" -- --yes 2>&1)" && status=0 || status=$?
check "an untagged instance named slax-prod: refused" sh -c "test $status != 0 && printf '%s' \"\$1\" | grep -q 'instance named slax-prod exists WITHOUT tag'" _ "$out"
check "... not a single write call" test -z "$(writes)"
check "... before any change" test "$(slax_ids | sed 's/^instances=.*/instances=/' | tr '\n' ' ')" = "instances= sgs= eips= buckets= roles= "

reset_moto
world
aws s3api create-bucket --bucket "$files" --create-bucket-configuration LocationConstraint=eu-central-1 >/dev/null
out="$(provision -e TS_AUTHKEY="$ts_key" -- --yes 2>&1)" && status=0 || status=$?
check "an untagged bucket with the slax name: refused, with the command to adopt it" sh -c "test $status != 0 && printf '%s' \"\$1\" | grep -q 'put-bucket-tagging --bucket $files'" _ "$out"
check "... not a single write call" test -z "$(writes)"
check "... and the bucket is left as it was (no tag added)" sh -c "! docker run --rm --network $name ${env_args[*]} $cli_image s3api get-bucket-tagging --bucket $files >/dev/null 2>&1"

reset_moto
world
aws iam create-role --role-name slax-prod-instance --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
out="$(provision -e TS_AUTHKEY="$ts_key" -- --yes 2>&1)" && status=0 || status=$?
check "an untagged role named slax-prod-instance: refused" sh -c "test $status != 0 && printf '%s' \"\$1\" | grep -q 'IAM role slax-prod-instance exists WITHOUT tag'" _ "$out"
check "... not a single write call" test -z "$(writes)"
check "... and its policies are left alone" test "$(aws iam list-role-policies --role-name slax-prod-instance --query 'length(PolicyNames)' --output text)" = 0

if [ "${SKIP_CLOUD_INIT_SCHEMA:-0}" != 1 ]; then
    echo "== cloud-init schema of the rendered user data"
    chmod 644 "$dir/user-data"
    schema="$(docker run --rm -v "$dir/user-data:/user-data:ro" "$ubuntu_image" sh -c \
        'apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cloud-init >/dev/null 2>&1 && cloud-init schema --config-file /user-data' 2>&1)" \
        && status=0 || status=$?
    check "cloud-init schema --config-file: valid" sh -c "test $status = 0 && printf '%s' \"\$1\" | grep -q 'Valid schema'" _ "$schema" \
        || printf '%s\n' "$schema" | tail -10
fi

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "All provisioning checks passed"
