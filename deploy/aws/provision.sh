#!/usr/bin/env bash
# Slax production on AWS: creates what is missing, converges the settings of what exists,
# never touches anything else. Run by a human with their own AWS CLI v2 login
# (docs/runbook.md, "First-time production setup"):
#
#   deploy/aws/provision.sh --dry-run     the plan and the monthly cost; read-only calls only
#   TS_AUTHKEY=tskey-auth-... deploy/aws/provision.sh          asks for a typed confirmation
#   TS_AUTHKEY=tskey-auth-... deploy/aws/provision.sh --yes    no question (automation)
#
# Resources (every one tagged Project=slax and named slax-*):
#   S3 buckets   slax-files-<suffix>, slax-backups-<suffix>: Block Public Access, SSE-S3,
#                bucket owner enforced, TLS only; backups versioned and expiring after 35
#                days; incomplete multipart uploads aborted after a day on both
#   IAM          role + instance profile slax-prod-instance: those two buckets only (files:
#                read/write/delete; backups: read/write under pg/, no delete at all)
#   EC2          security group slax-prod (TCP 80/443 in, nothing else); instance slax-prod
#                (Graviton, Ubuntu 24.04 arm64 from Canonical's public SSM parameter, gp3
#                encrypted with the account's default EBS key, IMDSv2 only with hop limit 2,
#                no key pair, termination protection, standard CPU credits, no detailed
#                monitoring, user data deploy/aws/cloud-init.yaml); an Elastic IP
#
# Safety rules (the AWS account also runs unrelated things that must never be touched):
#   - every lookup filters on tag Project=slax (plus the slax-* name);
#   - a resource with a slax-* name but without that tag is someone else's: the script stops;
#   - before modifying anything that already exists, its tag is checked again;
#   - the script contains no terminate/delete/release/revoke/detach call at all; teardown is
#     a manual step (docs/runbook.md, "Teardown") on slax-tagged ids only;
#   - in --dry-run every mutating call is refused by construction (aws_write).
#
# Environment:
#   AWS_REGION          eu-central-1 (Frankfurt)
#   TS_AUTHKEY          Tailscale auth key, needed only to create the instance: single use,
#                       pre-approved, tag:slax-prod, expiring in 1 hour (it stays readable in
#                       the instance's user data). Never echoed.
#   SLAX_BUCKET_SUFFIX  bucket name suffix (bucket names are global); default: 10 hex
#                       characters of sha256("slax:" + account id), stable for the account
#   SLAX_INSTANCE_TYPE  t4g.small        SLAX_ROOT_GB  30
#   SLAX_AMI_PARAMETER  Canonical's SSM parameter for Ubuntu 24.04 arm64 (tests use their own)
#   AWS_ENDPOINT_URL    (tests only) a local AWS emulator
set -euo pipefail
umask 077

readonly NAME=slax-prod
readonly ROLE=slax-prod-instance
readonly PUBLIC_HOST=slax.yechpa.com
readonly DEV_HOST=dev.slax.yechpa.com
readonly BACKUP_PREFIX=pg
readonly SG_PORTS=(80 443)

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dry_run=0
assume_yes=0

usage() {
    sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) dry_run=1 ;;
        --yes) assume_yes=1 ;;
        -h | --help) usage; exit 0 ;;
        *) echo "provision: unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

export AWS_REGION="${AWS_REGION:-eu-central-1}"
export AWS_PAGER=""
region="$AWS_REGION"
instance_type="${SLAX_INSTANCE_TYPE:-t4g.small}"
root_gb="${SLAX_ROOT_GB:-30}"
ami_parameter="${SLAX_AMI_PARAMETER:-/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

die() {
    echo "provision: $*" >&2
    exit 1
}
say() { printf '%s\n' "$*"; }

# Read-only AWS calls.
aws_read() { aws "$@"; }
# Every call that changes anything goes through here: refused in a dry run.
aws_write() {
    [ "$dry_run" = 0 ] || die "internal error: '$1 $2' attempted during --dry-run"
    echo "  + aws $1 $2" >&2
    aws "$@"
}
# A JMESPath that counts the Project=slax tag of the Tags list at $1.
slax_tag_count() { printf "length((%s || \`[]\`)[?Key=='Project' && Value=='slax'])" "$1"; }
tags_cli=("Key=Project,Value=slax")
tags_spec() { printf 'ResourceType=%s,Tags=[{Key=Project,Value=slax},{Key=Name,Value=%s}]' "$1" "$2"; }
none() { [ -z "$1" ] || [ "$1" = None ] || [ "$1" = null ]; }

# ---------------------------------------------------------------------------------------
# Checks
[[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "AWS_REGION is not a region name: $region"
[[ "$instance_type" =~ ^t4g\.(small|medium|large|xlarge)$ ]] \
    || die "SLAX_INSTANCE_TYPE must be an ARM64 (Graviton) t4g.small/medium/large/xlarge, got $instance_type"
[[ "$root_gb" =~ ^[0-9]+$ ]] && [ "$root_gb" -ge 20 ] && [ "$root_gb" -le 200 ] || die "SLAX_ROOT_GB must be 20 to 200"
command -v aws >/dev/null || die "the AWS CLI v2 is required (aws)"
aws --version 2>&1 | grep -q '^aws-cli/2\.' || die "the AWS CLI must be version 2 (aws --version: $(aws --version 2>&1))"
[ "$region" = eu-central-1 ] || say "Note: region $region, not the planned eu-central-1."

account="$(aws_read sts get-caller-identity --query Account --output text)" || die "no AWS credentials (aws sso login / aws configure)"
[[ "$account" =~ ^[0-9]{12}$ ]] || die "unexpected account id from STS"
suffix="${SLAX_BUCKET_SUFFIX:-$(printf 'slax:%s' "$account" | sha256sum | cut -c1-10)}"
[[ "$suffix" =~ ^[a-z0-9]{4,20}$ ]] || die "SLAX_BUCKET_SUFFIX must be 4-20 lowercase letters or digits"
files_bucket="slax-files-$suffix"
backups_bucket="slax-backups-$suffix"

say "Slax production on AWS — account ********${account: -4}, region $region$([ "$dry_run" = 1 ] && echo ', DRY RUN (read-only)')"
say ""

# ---------------------------------------------------------------------------------------
# What exists (read-only)

# bucket_state NAME -> missing | ours | foreign | untagged
bucket_state() {
    local err="$tmp/head-bucket.err" count
    if aws_read s3api head-bucket --bucket "$1" --expected-bucket-owner "$account" >/dev/null 2>"$err"; then
        if count="$(aws_read s3api get-bucket-tagging --bucket "$1" --expected-bucket-owner "$account" \
            --query "$(slax_tag_count TagSet)" --output text 2>/dev/null)" && [ "$count" = 1 ]; then
            echo ours
        else
            echo untagged
        fi
    elif grep -qE '\(404\)|Not Found|NoSuchBucket' "$err"; then
        echo missing
    elif grep -qE '\(403\)|Forbidden|AccessDenied' "$err"; then
        echo foreign
    else
        cat "$err" >&2
        die "cannot tell whether bucket $1 exists"
    fi
}

# iam_state KIND NAME -> missing | ours | untagged    (KIND: role | instance-profile)
iam_state() {
    local err="$tmp/iam.err" query count
    if [ "$1" = role ]; then query="$(slax_tag_count Role.Tags)"; else query="$(slax_tag_count InstanceProfile.Tags)"; fi
    if count="$(aws_read iam "get-$1" "--$1-name" "$2" --query "$query" --output text 2>"$err")"; then
        if [ "$count" = 1 ]; then echo ours; else echo untagged; fi
    elif grep -q NoSuchEntity "$err"; then
        echo missing
    else
        cat "$err" >&2
        die "cannot read IAM $1 $2"
    fi
}

vpc="$(aws_read ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
none "$vpc" && die "no default VPC in $region. This script does not create networks: create one (aws ec2 create-default-vpc) and run it again."

sg_id="$(aws_read ec2 describe-security-groups --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=$NAME" \
    Name=tag:Project,Values=slax --query 'SecurityGroups[0].GroupId' --output text)"
sg_any="$(aws_read ec2 describe-security-groups --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=$NAME" \
    --query 'SecurityGroups[0].GroupId' --output text)"
if none "$sg_id" && ! none "$sg_any"; then
    die "security group $NAME ($sg_any) exists WITHOUT tag Project=slax: not created by this script, refusing to use or change it."
fi

alive=Name=instance-state-name,Values=pending,running,stopping,stopped
instances="$(aws_read ec2 describe-instances --filters Name=tag:Project,Values=slax "Name=tag:Name,Values=$NAME" "$alive" \
    --query 'Reservations[].Instances[].InstanceId' --output text)"
named="$(aws_read ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" "$alive" \
    --query 'Reservations[].Instances[].InstanceId' --output text)"
[ "$(wc -w <<< "$instances")" -le 1 ] || die "more than one instance tagged Project=slax Name=$NAME ($instances): resolve by hand first."
if [ "$(wc -w <<< "$named")" -gt "$(wc -w <<< "$instances")" ]; then
    die "an instance named $NAME exists WITHOUT tag Project=slax ($named): not created by this script, refusing."
fi
instance_id="$(tr -d '[:space:]' <<< "$instances")"

eip_alloc="$(aws_read ec2 describe-addresses --filters Name=tag:Project,Values=slax "Name=tag:Name,Values=$NAME" \
    --query 'Addresses[0].AllocationId' --output text)"
role_state="$(iam_state role "$ROLE")"
profile_state="$(iam_state instance-profile "$ROLE")"
files_state="$(bucket_state "$files_bucket")"
backups_state="$(bucket_state "$backups_bucket")"

for pair in "role:$role_state" "instance-profile:$profile_state"; do
    [ "${pair#*:}" != untagged ] || die "IAM ${pair%%:*} $ROLE exists WITHOUT tag Project=slax: not created by this script, refusing."
done
for pair in "$files_bucket:$files_state" "$backups_bucket:$backups_state"; do
    case "${pair#*:}" in
        foreign) die "bucket ${pair%%:*} belongs to another AWS account: choose another SLAX_BUCKET_SUFFIX." ;;
        untagged)
            die "bucket ${pair%%:*} is in this account WITHOUT tag Project=slax. If an interrupted run of this script created it, tag it yourself, then run again:
  aws s3api put-bucket-tagging --bucket ${pair%%:*} --tagging 'TagSet=[{Key=Project,Value=slax},{Key=Name,Value=${pair%%:*}}]'" ;;
    esac
done

ami="$(aws_read ssm get-parameter --name "$ami_parameter" --query Parameter.Value --output text)"
read -r ami_arch ami_root ami_name <<< "$(aws_read ec2 describe-images --image-ids "$ami" \
    --query 'Images[0].[Architecture,RootDeviceName,Name]' --output text)"
[ "$ami_arch" = arm64 ] || die "AMI $ami ($ami_parameter) is $ami_arch, not arm64"

# ---------------------------------------------------------------------------------------
# Plan and cost

state() { if none "$1" || [ "$1" = missing ]; then echo "create"; else echo "exists: $1"; fi; }
say "Plan (create what is missing; settings re-applied to slax-tagged resources only):"
say "  S3 bucket          $files_bucket  [$(state "${files_state/ours/Project=slax}")]"
say "  S3 bucket          $backups_bucket  [$(state "${backups_state/ours/Project=slax}")]"
say "  IAM role           $ROLE  [$(state "${role_state/ours/Project=slax}")]  inline policy slax-prod-s3"
say "  instance profile   $ROLE  [$(state "${profile_state/ours/Project=slax}")]"
say "  security group     $NAME in $vpc  [$(state "$sg_id")]  inbound TCP ${SG_PORTS[*]} only"
say "  EC2 instance       $NAME  $instance_type, ${root_gb} GB gp3 encrypted, $ami ($ami_name)  [$(state "$instance_id")]"
say "  Elastic IP         $NAME  [$(state "$eip_alloc")]"
say ""

# On-demand list prices, eu-central-1, USD (October 2026; check https://aws.amazon.com/ec2/pricing/).
case "$instance_type" in
    t4g.small) hourly=0.0192 ;;
    t4g.medium) hourly=0.0384 ;;
    t4g.large) hourly=0.0768 ;;
    t4g.xlarge) hourly=0.1536 ;;
esac
read -r c_instance c_ebs c_ip c_s3 c_total <<< "$(awk -v h="$hourly" -v gb="$root_gb" 'BEGIN {
    i = h * 730; e = gb * 0.0952; p = 0.005 * 730; s = 5 * 0.0245 + 0.25
    printf "%.2f %.2f %.2f %.2f %.2f", i, e, p, s, i + e + p + s }')"
say "This will cost about \$$c_total/month once everything runs (on-demand list prices, 730 h, before tax):"
printf '  %-30s $%6s\n' "EC2 $instance_type" "$c_instance" "EBS gp3 ${root_gb} GB" "$c_ebs" \
    "public IPv4 (the Elastic IP)" "$c_ip" "S3 (~5 GB + requests)" "$c_s3"
say "  data transfer out: the first 100 GB/month are free"
say ""

if [ "$dry_run" = 1 ]; then
    say "Dry run: nothing was changed."
    exit 0
fi

# ---------------------------------------------------------------------------------------
# Confirmation
need_instance=0
none "$instance_id" && need_instance=1
if [ "$need_instance" = 1 ]; then
    [ -n "${TS_AUTHKEY:-}" ] || die "TS_AUTHKEY is required to create the instance (single use, pre-approved, tag:slax-prod, 1 hour)"
    [[ "$TS_AUTHKEY" =~ ^tskey-auth-[A-Za-z0-9_-]{10,}$ ]] || die "TS_AUTHKEY does not look like a Tailscale auth key (tskey-auth-...)"
fi
if [ "$assume_yes" != 1 ]; then
    [ -t 0 ] || die "not a terminal: confirm interactively, or pass --yes"
    read -r -p "Type 'create slax-prod' to go ahead: " answer
    [ "$answer" = "create slax-prod" ] || die "not confirmed: nothing was changed"
fi

# ---------------------------------------------------------------------------------------
# S3

json_file() { # NAME CONTENT -> path of a private file holding CONTENT
    printf '%s' "$2" > "$tmp/$1"
    printf 'file://%s' "$tmp/$1"
}

converge_bucket() { # BUCKET KIND(files|backups) STATE
    local bucket="$1" kind="$2" state="$3" lifecycle
    if [ "$state" = missing ]; then
        say "Creating bucket $bucket"
        if [ "$region" = us-east-1 ]; then
            aws_write s3api create-bucket --bucket "$bucket" --object-ownership BucketOwnerEnforced >/dev/null
        else
            aws_write s3api create-bucket --bucket "$bucket" --object-ownership BucketOwnerEnforced \
                --create-bucket-configuration "LocationConstraint=$region" >/dev/null
        fi
        aws_write s3api put-bucket-tagging --bucket "$bucket" --expected-bucket-owner "$account" \
            --tagging "TagSet=[{Key=Project,Value=slax},{Key=Name,Value=$bucket}]"
    fi
    [ "$(bucket_state "$bucket")" = ours ] || die "bucket $bucket is not tagged Project=slax: refusing to configure it"
    say "Configuring bucket $bucket ($kind)"
    aws_write s3api put-public-access-block --bucket "$bucket" --expected-bucket-owner "$account" \
        --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    aws_write s3api put-bucket-ownership-controls --bucket "$bucket" --expected-bucket-owner "$account" \
        --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
    aws_write s3api put-bucket-encryption --bucket "$bucket" --expected-bucket-owner "$account" \
        --server-side-encryption-configuration "$(json_file "sse-$kind.json" \
            '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}')"
    aws_write s3api put-bucket-policy --bucket "$bucket" --expected-bucket-owner "$account" \
        --policy "$(json_file "policy-$kind.json" "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"TlsOnly\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$bucket\",\"arn:aws:s3:::$bucket/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}")"
    if [ "$kind" = backups ]; then
        aws_write s3api put-bucket-versioning --bucket "$bucket" --expected-bucket-owner "$account" \
            --versioning-configuration Status=Enabled
        lifecycle="{\"Rules\":[
            {\"ID\":\"slax-backups-expire\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"$BACKUP_PREFIX/\"},\"Expiration\":{\"Days\":35},\"NoncurrentVersionExpiration\":{\"NoncurrentDays\":7}},
            {\"ID\":\"slax-expired-markers\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"\"},\"Expiration\":{\"ExpiredObjectDeleteMarker\":true}},
            {\"ID\":\"slax-abort-multipart\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"\"},\"AbortIncompleteMultipartUpload\":{\"DaysAfterInitiation\":1}}]}"
    else
        lifecycle='{"Rules":[{"ID":"slax-abort-multipart","Status":"Enabled","Filter":{"Prefix":""},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'
    fi
    aws_write s3api put-bucket-lifecycle-configuration --bucket "$bucket" --expected-bucket-owner "$account" \
        --lifecycle-configuration "$(json_file "lifecycle-$kind.json" "$lifecycle")" >/dev/null
}

converge_bucket "$files_bucket" files "$files_state"
converge_bucket "$backups_bucket" backups "$backups_state"

# ---------------------------------------------------------------------------------------
# IAM: the instance role, limited to the two buckets

if [ "$role_state" = missing ]; then
    say "Creating IAM role $ROLE"
    aws_write iam create-role --role-name "$ROLE" --max-session-duration 3600 \
        --description "Slax production EC2 instance: its two S3 buckets only" \
        --assume-role-policy-document "$(json_file trust.json \
            '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}')" \
        --tags "${tags_cli[@]}" "Key=Name,Value=$ROLE" >/dev/null
fi
[ "$(iam_state role "$ROLE")" = ours ] || die "IAM role $ROLE is not tagged Project=slax: refusing to change it"
say "Setting the role's policy (slax-prod-s3)"
aws_write iam put-role-policy --role-name "$ROLE" --policy-name slax-prod-s3 --policy-document "$(json_file role-policy.json "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Sid\": \"FilesBucket\", \"Effect\": \"Allow\",
     \"Action\": [\"s3:ListBucket\", \"s3:ListBucketMultipartUploads\", \"s3:GetBucketLocation\"],
     \"Resource\": \"arn:aws:s3:::$files_bucket\"},
    {\"Sid\": \"FilesObjects\", \"Effect\": \"Allow\",
     \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:DeleteObject\", \"s3:AbortMultipartUpload\", \"s3:ListMultipartUploadParts\"],
     \"Resource\": \"arn:aws:s3:::$files_bucket/*\"},
    {\"Sid\": \"BackupsLocation\", \"Effect\": \"Allow\",
     \"Action\": [\"s3:GetBucketLocation\"],
     \"Resource\": \"arn:aws:s3:::$backups_bucket\"},
    {\"Sid\": \"BackupsList\", \"Effect\": \"Allow\",
     \"Action\": [\"s3:ListBucket\"],
     \"Resource\": \"arn:aws:s3:::$backups_bucket\",
     \"Condition\": {\"StringLike\": {\"s3:prefix\": [\"$BACKUP_PREFIX/\", \"$BACKUP_PREFIX/*\"]}}},
    {\"Sid\": \"BackupsObjectsNoDelete\", \"Effect\": \"Allow\",
     \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:AbortMultipartUpload\", \"s3:ListMultipartUploadParts\"],
     \"Resource\": \"arn:aws:s3:::$backups_bucket/$BACKUP_PREFIX/*\"}
  ]
}")"

if [ "$profile_state" = missing ]; then
    say "Creating instance profile $ROLE"
    aws_write iam create-instance-profile --instance-profile-name "$ROLE" \
        --tags "${tags_cli[@]}" "Key=Name,Value=$ROLE" >/dev/null
fi
[ "$(iam_state instance-profile "$ROLE")" = ours ] || die "instance profile $ROLE is not tagged Project=slax: refusing to change it"
profile_roles="$(aws_read iam get-instance-profile --instance-profile-name "$ROLE" --query 'InstanceProfile.Roles[].RoleName' --output text)"
if none "$profile_roles"; then
    aws_write iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
elif [ "$profile_roles" != "$ROLE" ]; then
    die "instance profile $ROLE holds another role ($profile_roles): refusing to change it"
fi

# ---------------------------------------------------------------------------------------
# Security group: TCP 80 and 443 from anywhere, nothing else (no 22, no 6443)

require_ours_sg() {
    [ "$(aws_read ec2 describe-security-groups --group-ids "$1" --query "$(slax_tag_count 'SecurityGroups[0].Tags')" --output text)" = 1 ] \
        || die "security group $1 is not tagged Project=slax: refusing to change it"
}
if none "$sg_id"; then
    say "Creating security group $NAME"
    sg_id="$(aws_write ec2 create-security-group --group-name "$NAME" --vpc-id "$vpc" \
        --description "Slax production: HTTP and HTTPS only (SSH and the Kubernetes API via Tailscale)" \
        --tag-specifications "$(tags_spec security-group "$NAME")" --query GroupId --output text)"
fi
require_ours_sg "$sg_id"
ensure_ingress() { # PORT LIST FIELD CIDR: one inbound TCP rule, added when missing
    local port="$1" list="$2" field="$3" cidr="$4" present
    present="$(aws_read ec2 describe-security-groups --group-ids "$sg_id" --query \
        "length(SecurityGroups[0].IpPermissions[?IpProtocol=='tcp' && FromPort==\`$port\` && ToPort==\`$port\`].${list}[] | [?${field}=='$cidr'])" \
        --output text)"
    if [ "$present" = 0 ]; then
        aws_write ec2 authorize-security-group-ingress --group-id "$sg_id" \
            --ip-permissions "IpProtocol=tcp,FromPort=$port,ToPort=$port,$list=[{$field=$cidr,Description=slax-public}]" \
            --tag-specifications "$(tags_spec security-group-rule "$NAME")" >/dev/null
    fi
}
for port in "${SG_PORTS[@]}"; do
    ensure_ingress "$port" IpRanges CidrIp 0.0.0.0/0
    ensure_ingress "$port" Ipv6Ranges CidrIpv6 ::/0
done
unexpected="$(aws_read ec2 describe-security-groups --group-ids "$sg_id" --query \
    "SecurityGroups[0].IpPermissions[?!(IpProtocol=='tcp' && (FromPort==\`80\` && ToPort==\`80\` || FromPort==\`443\` && ToPort==\`443\`))].[IpProtocol,FromPort,ToPort]" \
    --output text)"
if ! none "$unexpected"; then
    say "WARNING: security group $sg_id has inbound rules beyond TCP 80/443 (left untouched by this script):"
    say "$unexpected" | sed 's/^/    /'
    say "  Review and remove them by hand (aws ec2 describe-security-groups --group-ids $sg_id)."
fi

# ---------------------------------------------------------------------------------------
# The instance

require_ours_instance() {
    [ "$(aws_read ec2 describe-instances --instance-ids "$1" \
        --query "$(slax_tag_count 'Reservations[0].Instances[0].Tags')" --output text)" = 1 ] \
        || die "instance $1 is not tagged Project=slax: refusing to change it"
}

if [ "$need_instance" = 1 ]; then
    subnet="$(aws_read ec2 describe-subnets --filters "Name=vpc-id,Values=$vpc" Name=default-for-az,Values=true \
        --query 'sort_by(Subnets, &AvailabilityZone)[0].SubnetId' --output text)"
    none "$subnet" && die "the default VPC has no default subnet"

    # User data: cloud-init.yaml with the auth key and the Caddyfile, in a private file.
    [ -f "$here/cloud-init.yaml" ] && [ -f "$here/Caddyfile" ] || die "cloud-init.yaml and Caddyfile must be next to this script"
    user_data="$(cat "$here/cloud-init.yaml")"
    caddyfile_b64="$(base64 -w0 < "$here/Caddyfile")"
    user_data="${user_data//__SLAX_TS_AUTHKEY__/$TS_AUTHKEY}"
    user_data="${user_data//__SLAX_CADDYFILE_B64__/$caddyfile_b64}"
    [[ "$user_data" != *__SLAX_* ]] || die "cloud-init.yaml has a placeholder this script does not fill"
    printf '%s\n' "$user_data" > "$tmp/user-data"
    user_data_arg="file://$tmp/user-data"
    if [ "$(stat -c %s "$tmp/user-data")" -gt 16000 ]; then
        gzip -9 -n -c "$tmp/user-data" > "$tmp/user-data.gz"
        user_data_arg="fileb://$tmp/user-data.gz"
    fi

    say "Creating instance $NAME ($instance_type) in $subnet"
    for attempt in $(seq 1 12); do
        # A new instance profile takes a few seconds to be usable by EC2.
        if instance_id="$(aws_write ec2 run-instances --image-id "$ami" --instance-type "$instance_type" --count 1 \
            --subnet-id "$subnet" --security-group-ids "$sg_id" \
            --iam-instance-profile "Name=$ROLE" \
            --block-device-mappings "[{\"DeviceName\":\"$ami_root\",\"Ebs\":{\"VolumeSize\":$root_gb,\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}}]" \
            --metadata-options HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled,InstanceMetadataTags=disabled \
            --credit-specification CpuCredits=standard \
            --monitoring Enabled=false \
            --disable-api-termination \
            --instance-initiated-shutdown-behavior stop \
            --user-data "$user_data_arg" \
            --tag-specifications "$(tags_spec instance "$NAME")" "$(tags_spec volume "$NAME-root")" "$(tags_spec network-interface "$NAME")" \
            --query 'Instances[0].InstanceId' --output text 2>"$tmp/run.err")"; then
            break
        fi
        if grep -qi 'instance profile\|iamInstanceProfile' "$tmp/run.err" && [ "$attempt" -lt 12 ]; then
            say "  (the instance profile is not usable yet; retrying in 5 s)"
            sleep 5
        else
            cat "$tmp/run.err" >&2
            die "run-instances failed"
        fi
    done
    rm -f "$tmp/user-data" "$tmp/user-data.gz"
    say "  instance $instance_id: waiting until it runs"
    aws_read ec2 wait instance-running --instance-ids "$instance_id"
fi

require_ours_instance "$instance_id"
# Settings that must hold on the existing instance too.
read -r tokens hops <<< "$(aws_read ec2 describe-instances --instance-ids "$instance_id" \
    --query 'Reservations[0].Instances[0].MetadataOptions.[HttpTokens,HttpPutResponseHopLimit]' --output text)"
if [ "$tokens" != required ] || [ "$hops" != 2 ]; then
    aws_write ec2 modify-instance-metadata-options --instance-id "$instance_id" \
        --http-tokens required --http-put-response-hop-limit 2 --http-endpoint enabled >/dev/null
fi
protected="$(aws_read ec2 describe-instance-attribute --instance-id "$instance_id" --attribute disableApiTermination \
    --query DisableApiTermination.Value --output text)"
[ "$protected" = True ] || aws_write ec2 modify-instance-attribute --instance-id "$instance_id" --disable-api-termination
read -r current_type current_profile <<< "$(aws_read ec2 describe-instances --instance-ids "$instance_id" \
    --query 'Reservations[0].Instances[0].[InstanceType,IamInstanceProfile.Arn]' --output text)"
[ "$current_type" = "$instance_type" ] \
    || say "Note: $instance_id is a $current_type (SLAX_INSTANCE_TYPE=$instance_type). Resizing is a manual step: docs/runbook.md, \"Scale\"."
[[ "$current_profile" == */"$ROLE" ]] || say "WARNING: $instance_id does not use the instance profile $ROLE."

# ---------------------------------------------------------------------------------------
# Elastic IP

if none "$eip_alloc"; then
    say "Allocating an Elastic IP"
    eip_alloc="$(aws_write ec2 allocate-address --domain vpc --tag-specifications "$(tags_spec elastic-ip "$NAME")" \
        --query AllocationId --output text)"
fi
read -r eip eip_instance <<< "$(aws_read ec2 describe-addresses --allocation-ids "$eip_alloc" \
    --query 'Addresses[0].[PublicIp,InstanceId]' --output text)"
[ "$(aws_read ec2 describe-addresses --allocation-ids "$eip_alloc" --query "$(slax_tag_count 'Addresses[0].Tags')" --output text)" = 1 ] \
    || die "Elastic IP $eip_alloc is not tagged Project=slax: refusing to change it"
if none "$eip_instance"; then
    aws_write ec2 associate-address --allocation-id "$eip_alloc" --instance-id "$instance_id" >/dev/null
elif [ "$eip_instance" != "$instance_id" ]; then
    die "Elastic IP $eip is associated with another instance ($eip_instance): refusing to move it"
fi

# ---------------------------------------------------------------------------------------
# What the human does next

cat <<EOF

Done. Slax production on AWS ($region):
  instance      $instance_id ($instance_type)   Elastic IP $eip
  files bucket  $files_bucket
  backups       $backups_bucket (s3://$backups_bucket/$BACKUP_PREFIX/, 35 days)

YOU DO THIS next (docs/runbook.md, "First-time production setup"):
  1. DNS at your provider: A  $PUBLIC_HOST  ->  $eip   (TTL 300)
     No record for files.$PUBLIC_HOST: browsers download files from
     https://$files_bucket.s3.$region.amazonaws.com (presigned URLs).
  2. Google OAuth client, Authorized redirect URIs:
       https://$DEV_HOST/auth/google/callback
       https://$PUBLIC_HOST/auth/google/callback
  3. GitHub environment "production", variables:
       SLAX_FILES_BUCKET=$files_bucket
       SLAX_BACKUPS_BUCKET=$backups_bucket
  4. In 5-10 minutes the node is on the tailnet as slax-prod (tag:slax-prod):
       tailscale ssh ubuntu@slax-prod -- cloud-init status --wait
       tailscale ssh ubuntu@slax-prod -- sudo tail -n 20 /var/log/slax-bootstrap.log
EOF
