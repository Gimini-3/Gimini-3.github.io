---
title: "[Java Concurrency] 모니터 락과 wait/notifyAll로 턴 스케줄러 구현하기"
date: 2025-09-30 18:31:00 +0900
tags:
  - java
  - Concurrency
  - monitor lock
  - wait-notifyAll
thumbnail: ""
---

# 모니터락

```java
public class StartTest2_2Main {

    //thread1 한 번 -> thread2 한 번 -> thread1 한 번 -> thread2 한 번 -> ...
    //순서 고정

    static final Object TURN_LOCK = new Object();
    static String next = "counter1";

    public static void main(String[] args){
        Thread thread1 = new Thread(new CounterRunnable(),"counter1");
        Thread thread2 = new Thread(new CounterRunnable(),"counter2");
        thread2.start();
        thread1.start();
    }

    static class CounterRunnable implements Runnable {
        public void run(){
            for(int i=1;i<=5;i++){
                try{
                    System.out.println(i+"번째 반복"+Thread.currentThread().getName()+" synchronized 들어가기 전"+ " 모니터락 보유 여부: "+Thread.holdsLock(TURN_LOCK));
                    synchronized(TURN_LOCK){
                        System.out.println(Thread.currentThread().getName()+" synchronized 들어간 후"+ " 모니터락 보유 여부: "+Thread.holdsLock(TURN_LOCK));
                        while(!Thread.currentThread().getName().equals(next)){
                            System.out.println(Thread.currentThread().getName()+" WAIT!"+ " 모니터락 보유 여부: "+Thread.holdsLock(TURN_LOCK));
                            TURN_LOCK.wait();
                            System.out.println(Thread.currentThread().getName()+" WAIT 풀림!"+ " 모니터락 보유 여부: "+Thread.holdsLock(TURN_LOCK));
                        }
                        log("value: "+i);

                        next = next.equals("counter1")?"counter2":"counter1";
                        TURN_LOCK.notifyAll();
                        System.out.println(Thread.currentThread().getName()+" notifyAll() 후"+ " 모니터락 보유 여부: "+Thread.holdsLock(TURN_LOCK));
                    }
                }catch(InterruptedException e){
                    Thread.currentThread().interrupt();
                }
            }
        }
    }
}
```

# 코드 분석

## 의도

두 스레드(`counter1`, `counter2`) 가 정해진 순서로 번갈아가며 작업을 수행하도록 만드는 턴 스케줄러를 구현했다.

## 핵심 요소

- `TURN_LOCK`: `Object` 모니터. `synchronized(TURN_LOCK)`로 **임계영역**을 보호한다.
    - 모든 객체는 모니터를 가지고 있으므로, 단순히 락 용도로 쓸 객체를 `new Object()`로 만들었다.
- `next`: 이번 턴의 **합의된 상태**. `"counter1"` 또는 `"counter2"` 문자열로 현재 차례를 표현한다.
- `while (!Thread.currentThread().getName().equals(next)) { TURN_LOCK.wait(); }`
    - 가드 조건. **내 차례가 아니면 곧바로 대기**로 전환하고, 깨어난 뒤에도 조건을 **반드시 재검사**한다.
- `next = ... ? "counter2" : "counter1";`
    - 임계영역에서 **턴을 전환**한다. 다음 차례를 명시적으로 선언한다.
- `TURN_LOCK.notifyAll();`
    - 턴을 바꾼 뒤, 같은 모니터의 **Wait Set**에 있는 모든 스레드를 깨운다.
- 로그
    - 각 지점에서 **락 보유 여부**를 눈으로 확인하려는 디버깅용 출력이다.

## 왜 이 실험을 하는가?

1. 모니터 모델을 눈으로 확인
   - “어느 시점에 락을 보유하는지/놓는지” 명확히 보기 위해서
1. `notifyAll()` 의 의미를 체감
   - 알림은 락을 넘기는 행위기 아님을 확인하고, 알림 뒤에도 실제 실행은 락 재경쟁으로 결정된다는 사실을 출력으로 관찰한다.
1. “스케줄러가 누구에게 CPU를 먼저 주든,최종 순서는 공유 상태가 보장한다”점을 실험으로 증명한다.
   - 운영체제의 스케줄러는 어떤 스레드에게 CPU를 먼저 줄지 전혀 보장하지 않는다.
   - 예를 들어:
       - `counter1` 이 락을 놓자마자 OS가 또 다시 `counter1` 에게 줄 수도 있고,
       - 아니면 `counter2` 에게 바로 CPU를 줄 수 있다.
   - 즉, CPU 실행 순서는 비결정적이다.
   - **CPU를 누가 먼저 차지하든 상관없이, 공유 상태(`next`)와 가드(while)가 순서를 보장한다는 의미이다.**

# 결과 분석

```java
1번째 반복counter2 synchronized 들어가기 전 모니터락 보유 여부: false
1번째 반복counter1 synchronized 들어가기 전 모니터락 보유 여부: false
counter2 synchronized 들어간 후 모니터락 보유 여부: true
counter2 WAIT! 모니터락 보유 여부: true
counter1 synchronized 들어간 후 모니터락 보유 여부: true
11:49:28.376 [ counter1] value: 1
counter1 notifyAll() 후 모니터락 보유 여부: true
2번째 반복counter1 synchronized 들어가기 전 모니터락 보유 여부: false
counter2 WAIT 풀림! 모니터락 보유 여부: true
11:49:28.384 [ counter2] value: 1
counter2 notifyAll() 후 모니터락 보유 여부: true
2번째 반복counter2 synchronized 들어가기 전 모니터락 보유 여부: false
counter2 synchronized 들어간 후 모니터락 보유 여부: true
counter2 WAIT! 모니터락 보유 여부: true
counter1 synchronized 들어간 후 모니터락 보유 여부: true
11:49:28.386 [ counter1] value: 2
counter1 notifyAll() 후 모니터락 보유 여부: true
3번째 반복counter1 synchronized 들어가기 전 모니터락 보유 여부: false
counter1 synchronized 들어간 후 모니터락 보유 여부: true
counter1 WAIT! 모니터락 보유 여부: true
counter2 WAIT 풀림! 모니터락 보유 여부: true
11:49:28.386 [ counter2] value: 2
counter2 notifyAll() 후 모니터락 보유 여부: true
3번째 반복counter2 synchronized 들어가기 전 모니터락 보유 여부: false
counter2 synchronized 들어간 후 모니터락 보유 여부: true
counter2 WAIT! 모니터락 보유 여부: true
counter1 WAIT 풀림! 모니터락 보유 여부: true
11:49:28.388 [ counter1] value: 3
counter1 notifyAll() 후 모니터락 보유 여부: true
4번째 반복counter1 synchronized 들어가기 전 모니터락 보유 여부: false
counter2 WAIT 풀림! 모니터락 보유 여부: true
11:49:28.389 [ counter2] value: 3
counter2 notifyAll() 후 모니터락 보유 여부: true
4번째 반복counter2 synchronized 들어가기 전 모니터락 보유 여부: false
counter1 synchronized 들어간 후 모니터락 보유 여부: true
11:49:28.390 [ counter1] value: 4
counter1 notifyAll() 후 모니터락 보유 여부: true
5번째 반복counter1 synchronized 들어가기 전 모니터락 보유 여부: false
counter1 synchronized 들어간 후 모니터락 보유 여부: true
counter1 WAIT! 모니터락 보유 여부: true
counter2 synchronized 들어간 후 모니터락 보유 여부: true
11:49:28.391 [ counter2] value: 4
counter2 notifyAll() 후 모니터락 보유 여부: true
5번째 반복counter2 synchronized 들어가기 전 모니터락 보유 여부: false
counter2 synchronized 들어간 후 모니터락 보유 여부: true
counter2 WAIT! 모니터락 보유 여부: true
counter1 WAIT 풀림! 모니터락 보유 여부: true
11:49:28.398 [ counter1] value: 5
counter1 notifyAll() 후 모니터락 보유 여부: true
counter2 WAIT 풀림! 모니터락 보유 여부: true
11:49:28.398 [ counter2] value: 5
counter2 notifyAll() 후 모니터락 보유 여부: true
```

## 1. 이 실행에서는 우연히 counter2가 먼저 for 루프에 진입했고, 그 다음에 counter1이 진입 (실제로는 매 실행마다 순서가 달라질 수 있다.)

```java
1번째 반복counter2 synchronized 들어가기 전 모니터락 보유 여부: false
1번째 반복counter1 synchronized 들어가기 전 모니터락 보유 여부: false
```

## 2. counter2가 먼저 들어왔으니 TURN_LOCK 객체의 모니터락을 잡고 synchronized(){} 문 안으로 들어감

```java
counter2 synchronized 들어간 후 모니터락 보유 여부: true
```

## 3.  counter2가 조건에 맞아 while문에 들어감 → wait 상태 들어감

```java
counter2 WAIT! 모니터락 보유 여부: true
```

- wait()를 호출한 시점 이후의 코드는, 스레드가 다시 깨워져서 락을 재획득할 때까지 실행되지 않는다.

## 4. counter1이 모니터 락을 잡아서 synchronized{} 문 안으로 들어감→ while 조건 해당을 만족하지 않으므로 진입하지 않음 → log 출력

```java
counter1 synchronized 들어간 후 모니터락 보유 여부: true
11:49:28.376 [ counter1] value: 1

```

## 5. log를 출력하고 잠들어 있는 스레드들을 깨움 (하지만 아직 락은 counter1이 가지고 있음)

```java
counter1 notifyAll() 후 모니터락 보유 여부: true
```

## 6. counter1 이 첫 번째 반복문이 끝나고 두 번째 반복문을 돈다(모니터락 보유 여부 : false)

```java
2번째 반복counter1 synchronized 들어가기 전 모니터락 보유 여부: false
```

## 7. counter2가 모니터 락을 잡아서 다시 wait() 뒤부터 시작 → while 문에서 탈출하여 log 출력( next 필드 값 변경했기 때문에 탈출)

```java
counter2 WAIT 풀림! 모니터락 보유 여부: true
11:49:28.384 [ counter2] value: 1

```

## 8. counter2이 첫 번째 반복문 끝나고 두 번째 반복문 돔(모니터락 보유 여부 : false)

```java
counter2 notifyAll() 후 모니터락 보유 여부: true
2번째 반복counter2 synchronized 들어가기 전 모니터락 보유 여부: false
```

- 이때 wait() 중인 스레드가 없기 때문에, notifyAll() 호출은 실질적으로 깰 대상이 없다.
- 만약 counter1이 모니터락을 잡고 먼저 들어왔다면 while 문에서 wait() 상태로 있었을 것

## 9. 다시 counter2가 모니터락 잡음 ( `notifyAll()`로 깨워도 잡기 위해서 경쟁해야함)

```java
counter2 synchronized 들어간 후 모니터락 보유 여부: true
```

## 10. 다시 순서는 counter1부터 시작해야하므로 counter2는 wait 상태로 전환

```java
counter2 WAIT! 모니터락 보유 여부: true
counter1 synchronized 들어간 후 모니터락 보유 여부: true
```

## 11. 반복문이 끝날 때까지 위의 과정 반복

# 주의사항

## 1. if가 아닌 while 은 필수

- 경쟁 상황(race)과 `notifyAll()`

  `notifyAll()`은 여러 스레드를 동시에 깨운다. 깬 다음 **락을 누가 먼저 잡느냐**는 운이다. 내가 먼저 깼지만, 락을 잡았을 때는 **이미 다른 스레드가 상태(`next`)를 바꿔서 내 차례가 아닐 수** 있다. 그래서 **깬 뒤에도 “정말 내 차례인가?”를 재확인**해야 한다.

1. 모니터락 권한을 얻으면 얻은 스레드는 wait(); 이후 코드부터 실행
2. if문은 그전에 검사했기 때문에 바로 탈출
3. 스레드가 여러 개 일 때 자신의 차례가 아니여도 뒤의 코드를 실행할 수 있음
    - (자신의 차례가 맞는지 확인하기 위해서 while()로 조건 다시 검사하는 것

## 2. `notifyAll()`은 모니터 락을 바로 부여하는 것이 아님

- `TURN_LOCK.notifyAll()` 을 호출하면, WAIT 중이던 스레드들을 깨우기만 한다.
- 하지만 아직은 현재 스레드가 `TURN_LOCK` 을 가지고 있으므로, 깨어난 스레드들은 실행하지 못하고 “락을 달라”면서 대기 상태가 된다.
- 현재 스레드가 블록을 벗어나면서 `TURN_LOCK` 모니터 락을 놓는다.
- 그 순간, `notifyAll()` 으로 깨어나 대기 중이던 스레드 중 하나가 락을 얻어 실행을 재개한다.
- 락을 얻은 스레드의 재개 지점은 `wait()` 가 끝난 곳(즉, `wait()` 호출 바로 다음 줄) 부터이다.

## 3. `notifyAll()`은 대기 큐에 있는 스레드들을 깨움

- `wait()`를 호출한 스레드는 `RUNNABLE` 상태가 아니라, `WAITING` 상태로 바뀌어서 `TURN_LOCK`의 wait set(대기 집합, 큐) 에 들어가게 된다.
- `notifyAll()` 은 이 wait set에 들어가 있는 모든 스레드를 깨우는 것이다.

### 대기 큐는 어디 있나?

- 각 객체(`TURN_LOCK` 같은 Object)는 JVM 안에서 하나의 모니터를 갖는다.
- 이 모니터에는 크게 두 가지 내부 자료구조가 있다
    - Entry Set: synchronized 블록 안에 들어가려고 락을 기다리는 스레드들의 집합 (항상 경쟁 상태)
    - Wait Set: 이미 락을 가지고 있는 스레드가 `wait()`를 호출하면서 자발적으로 락을 내려놓고 들어가는 대기 집합 (비활성 대기)
- Entry Set은 락을 얻기 위해 경쟁하는 것이고 Wait Set은 경쟁하는 것이 아닌 락을 내려놓고 스스로 잠드는 상태
    - Wait Set이 `notifyAll()` 을 통해서 깨어나야지 락을 얻기 위해 경쟁하는 것

## 4. `counter1`이 `synchronized` 블록을 빠져나온 뒤, 다음 반복에서 락을 다시 먼저 획득 할 수도 있다.

```java
12:33:29.027 [ counter1] value: 3
counter1 notifyAll() 후 모니터락 보유 여부: true
4번째 반복counter1 synchronized 들어가기 전 모니터락 보유 여부: false
counter1 synchronized 들어간 후 모니터락 보유 여부: true
counter1 WAIT! 모니터락 보유 여부: true
counter2 synchronized 들어간 후 모니터락 보유 여부: true
12:33:29.028 [ counter2] value: 3
```

- `notifyAll()`은 깨우기만 하고, 락 소유권을 특정 스레드에 양도하지 않는다.
- "락은 `synchronized` 블록이 끝날 때 해제되고, 그 때 Entry Set + Wait Set에서 깨어난 스레드들이 다 같이 경쟁해서 한 스레드가 다시 얻는다.
- 위의 코드에서 처럼
    - 방금 블록을 빠져나온 `counter1`
    - `wait()` 에서 깨워져 경쟁에 합류한 `counter2`
    - 경쟁해서 `counter1` 이 다시 들어갔다.

### 코드가 안전하게 `counter1` → `counter2`→`counter1` → `counter2` 로 찍히는 이유

1. 턴 스위치

```java
next = next.equals("counter1") ? "counter2" : "counter1";
```

1. 가드 조건(반드시 while)

```java
while (!Thread.currentThread().getName().equals(next)) {
    TURN_LOCK.wait();
}
```