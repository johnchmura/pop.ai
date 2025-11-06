#!/bin/bash
set -e

cd /app/pop/www

declare -A YEAR_ITEMS=()
YEAR_ORDER=()

for file in $(ls -t data/*.js); do
    export SEMESTER_NAME=$(grep "var semesters = \[" $file | cut -d\" -f2)
    export SEMESTER_DATA=$file
    HTML_FILE=$(echo $SEMESTER_NAME | sed 's/ //g' | tr A-Z a-z).html
    cat semester.html.tpl | envsubst > $HTML_FILE

    SEASON=$(echo "$SEMESTER_NAME" | awk '{print $1}')
    YEAR=$(echo "$SEMESTER_NAME" | grep -o '[0-9][0-9][0-9][0-9]' | head -n1)

    if [[ -z "$YEAR" ]]; then
        continue
    fi

    if [[ "$SEASON" == "Fall" ]]; then
        START_YEAR=$YEAR
    else
        START_YEAR=$((YEAR - 1))
    fi
    END_YEAR=$((START_YEAR + 1))
    ACADEMIC_YEAR="$START_YEAR-$END_YEAR"

    if [[ -z ${YEAR_ITEMS[$ACADEMIC_YEAR]+_} ]]; then
        YEAR_ITEMS[$ACADEMIC_YEAR]=''
        YEAR_ORDER+=("$ACADEMIC_YEAR")
    fi

    YEAR_ITEMS[$ACADEMIC_YEAR]+=$'                <li><a href="'
    YEAR_ITEMS[$ACADEMIC_YEAR]+="$HTML_FILE"
    YEAR_ITEMS[$ACADEMIC_YEAR]+=$'">Search '
    YEAR_ITEMS[$ACADEMIC_YEAR]+="$SEMESTER_NAME"
    YEAR_ITEMS[$ACADEMIC_YEAR]+=$' Courses using Pop 1.0</a></li>\n'
done

export SEMESTER_GROUPS=""
for YEAR_LABEL in "${YEAR_ORDER[@]}"; do
    SEMESTER_GROUPS+=$'<section class="school-year">\n'
    SEMESTER_GROUPS+=$'            <h2>'
    SEMESTER_GROUPS+="$YEAR_LABEL School Year"
    SEMESTER_GROUPS+=$'</h2>\n'
    SEMESTER_GROUPS+=$'            <ul>\n'
    SEMESTER_GROUPS+="${YEAR_ITEMS[$YEAR_LABEL]}"
    SEMESTER_GROUPS+=$'            </ul>\n'
    SEMESTER_GROUPS+=$'        </section>\n'
done

cat index.html.tpl | envsubst > index.html

# Upload assets
s3cmd -c /app/.s3cfg sync . s3://pop.weclarify.com --no-mime-magic --recursive
