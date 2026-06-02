import requests
import json

cf_handle = "Cartethyia001"
api_url = f"https://codeforces.com/api/user.status?handle={cf_handle}&from=1&count=10"

try:
    print(f"Fetching recent submissions for user {cf_handle}...")
    response = requests.get(api_url, timeout=10.0)
    if response.status_code == 200:
        data = response.json()
        if data.get("status") == "OK":
            submissions = data.get("result", [])
            print(f"Found {len(submissions)} submissions.")
            for i, s in enumerate(submissions):
                print(f"\n--- Submission {i+1} ---")
                print(f"ID: {s.get('id')}")
                print(f"Contest ID: {s.get('contestId')}")
                print(f"Problem: {s.get('problem', {}).get('index')} - {s.get('problem', {}).get('name')}")
                print(f"Verdict: {s.get('verdict')}")
                print(f"Passed Test Count (passedTestCount): {s.get('passedTestCount')}")
                print(f"Time Consumed Millis (timeConsumedMillis): {s.get('timeConsumedMillis')}")
                print(f"Memory Consumed Bytes (memoryConsumedBytes): {s.get('memoryConsumedBytes')}")
        else:
            print(f"API Error: {data.get('comment')}")
    else:
        print(f"HTTP Error: {response.status_code}")
except Exception as e:
    print(f"Exception: {str(e)}")
